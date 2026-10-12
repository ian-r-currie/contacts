import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { parseCsv } from "./csv.ts";
import { openDb } from "./db.ts";
import { importCsv, importOrgsCsv, normalizeDate, previewCsv, splitNames } from "./importer.ts";

const PEOPLE = `Name,Department,Related to,Role,Updated,Schools,Website,Follow-up Date,Notes
Ada Lovelace,Math,"Charles Babbage, Mary",PhD Candidate,Oct 7 2026,"Cambridge, UCL",https://ada.example.com,"October 17, 2026","Met at a talk
Very friendly"
Grace Hopper,CS,Ada Lovelace,Student,Oct 11 2026,Yale,,,
`;

const PROFS = `School,Professor,Department,Website,Interest (/5),Research,Email,Notes,Emailed On
Cambridge,Charles Babbage,Engineering,https://babbage.example.com,5,Engines,cb@example.com,,n/a
Cambridge,,,https://www.marysomerville.example.org,4,,,From Ada,
,,,,,,,orphan note,
`;

test("parseCsv handles quotes, escaped quotes and embedded newlines", () => {
  assert.deepEqual(parseCsv('a,"b ""q""","c\nd"\r\n1,2,3\n'), [
    ["a", 'b "q"', "c\nd"],
    ["1", "2", "3"],
  ]);
});

test("normalizeDate and splitNames", () => {
  assert.equal(normalizeDate("Oct 7 2026"), "2026-10-07");
  assert.equal(normalizeDate("October 17, 2026"), "2026-10-17");
  assert.equal(normalizeDate("2026-01-02"), "2026-01-02");
  assert.equal(normalizeDate("n/a"), null);
  assert.deepEqual(splitNames("A B, C; D and E"), ["A B", "C", "D", "E"]);
});

test("import builds relationships, merges duplicates and matches nameless rows by website", () => {
  const db = openDb(":memory:");
  const first = importCsv(db, PEOPLE, {});
  assert.equal(first.created, 2);
  assert.equal(first.stubs, 2); // Charles Babbage, Mary
  assert.equal(first.relations, 3);
  assert.equal(db.findByName("charles babbage")!.in_network, false);

  const ada = db.listContacts().find((c) => c.name === "Ada Lovelace")!;
  assert.equal(ada.follow_up_date, "2026-10-17");
  assert.deepEqual(
    ada.orgs.map((o) => [o.name, o.type]),
    [
      ["Cambridge", "School"],
      ["UCL", "School"],
    ],
  );
  assert.equal(ada.notes, "Met at a talk\nVery friendly");
  assert.equal(ada.updated_at.slice(0, 10), "2026-10-07");
  assert.deepEqual(ada.related.map((r) => r.name).sort(), ["Charles Babbage", "Grace Hopper", "Mary"]);

  const second = importCsv(db, PROFS, { role: "Professor" });
  assert.equal(second.merged, 2); // Babbage by name, Mary by website domain
  assert.equal(second.created, 0);
  assert.equal(second.skipped, 1);

  const babbage = db.listContacts().find((c) => c.name === "Charles Babbage")!;
  assert.equal(babbage.role, "Professor");
  assert.equal(babbage.in_network, true); // was only a connection until the profs import
  assert.equal(babbage.research, "Engines");
  assert.equal(babbage.email, "cb@example.com");
  assert.deepEqual(babbage.orgs.map((o) => o.name), ["Cambridge"]);
  assert.equal(db.listOrgs().length, 3); // Cambridge (in both files, one org), UCL, Yale
  assert.equal(db.listContacts().find((c) => c.name === "Grace Hopper")!.in_network, true);
  const mary = db.listContacts().find((c) => c.name === "Mary")!;
  assert.equal(mary.website, "https://www.marysomerville.example.org");

  // Re-importing doesn't duplicate anything.
  importCsv(db, PEOPLE, {});
  assert.equal(db.listContacts().length, 4);
});

test("a nameless row imported first is renamed when someone references it later", () => {
  const db = openDb(":memory:");
  importCsv(db, PROFS, { role: "Professor" });
  assert.ok(db.listContacts().some((c) => c.name === "Unknown (marysomerville.example.org)"));
  importCsv(db, "Name,Related to\nAda Lovelace,Mary Somerville\n");
  const names = db.listContacts().map((c) => c.name);
  assert.ok(names.includes("Mary Somerville"));
  assert.ok(!names.some((n) => n.startsWith("Unknown")));
});

test("relationships are undirected and removed with the contact", () => {
  const db = openDb(":memory:");
  const a = db.createContact({ name: "A" });
  const b = db.createContact({ name: "B" });
  db.relate(b, a, "colleagues");
  assert.deepEqual(db.getContact(a)!.related, [{ id: b, name: "B", note: "colleagues", in_network: true }]);
  assert.deepEqual(db.getContact(b)!.related, [{ id: a, name: "A", note: "colleagues", in_network: true }]);
  db.deleteContact(b);
  assert.deepEqual(db.getContact(a)!.related, []);
});

test("follow-up notifications re-arm when the date changes", () => {
  const db = openDb(":memory:");
  const id = db.createContact({ name: "A", follow_up_date: "2026-10-10" });
  assert.equal(db.dueFollowUps("2026-10-11", true).length, 1);
  db.markNotified(id, "2026-10-10");
  assert.equal(db.dueFollowUps("2026-10-11", true).length, 0);
  db.updateContact(id, { follow_up_date: "2026-10-11" });
  assert.equal(db.dueFollowUps("2026-10-11", true).length, 1);
});

test("setting a person's organizations keeps current flags and reuses orgs by name", () => {
  const db = openDb(":memory:");
  const id = db.createContact({ name: "A" });
  db.setContactOrgs(id, ["UBC", "McGill"]);
  const mcgill = db.findOrg("mcgill")!;
  db.setMembership(id, mcgill.id, true);
  db.setContactOrgs(id, ["ubc", "McGill", "Vector Institute"]);
  assert.deepEqual(
    db.getContact(id)!.orgs.map((o) => [o.name, o.current]),
    [
      ["McGill", true],
      ["UBC", false],
      ["Vector Institute", false],
    ],
  );
  assert.equal(db.listOrgs().length, 3);
  db.setContactOrgs(id, ["UBC"]);
  assert.deepEqual(db.getContact(id)!.orgs.map((o) => o.name), ["UBC"]);
  assert.equal(db.listOrgs().find((o) => o.name === "McGill")!.members.length, 0); // the org itself stays
});

test("organization sheets import with parents, website-derived names and merging", () => {
  const db = openDb(":memory:");
  const ORGS = `School,Website,Org Name,Description
Cambridge,https://ethics.example.ac.uk,,Ethics centre
Cambridge,https://www.example.ac.uk/compute-lab/,Compute Lab,Builds engines
`;
  assert.equal(previewCsv(ORGS).kind, "orgs");
  assert.equal(previewCsv(PEOPLE).kind, "people");
  const s = importOrgsCsv(db, ORGS);
  assert.equal(s.created, 2);
  const orgs = Object.fromEntries(db.listOrgs().map((o) => [o.name, o]));
  assert.equal(orgs.Cambridge.type, "School");
  assert.equal(orgs["ethics.example.ac.uk"].parent_id, orgs.Cambridge.id);
  assert.equal(orgs["Compute Lab"].description, "Builds engines");
  // Renamed in the app, then re-imported: matched by website, not duplicated.
  db.updateOrg(orgs["ethics.example.ac.uk"].id, { name: "Ethics Centre" });
  const again = importOrgsCsv(db, ORGS);
  assert.equal(again.merged, 2);
  assert.equal(db.listOrgs().length, 3);
  assert.throws(() => db.updateOrg(orgs.Cambridge.id, { parent_id: orgs["Compute Lab"].id }), /part of itself/);
});

test("databases from earlier versions are migrated", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "contacts-")), "old.db");
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE contacts (id INTEGER PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT '',
      department TEXT NOT NULL DEFAULT '', schools TEXT NOT NULL DEFAULT '', research TEXT NOT NULL DEFAULT '', website TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '', last_contacted TEXT NOT NULL DEFAULT '', follow_up_date TEXT NOT NULL DEFAULT '',
      follow_up_notified TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '');
    CREATE TABLE relationships (a_id INTEGER NOT NULL, b_id INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT '', PRIMARY KEY (a_id, b_id));
    INSERT INTO contacts (id, name, category, role, schools) VALUES (1, 'Prof', 'Professor', '', 'UBC, McGill'), (2, 'Student', 'Contact', 'PhD', 'ubc'), (3, 'Friend', '', '', ''), (4, 'Loner', '', '', '');
    INSERT INTO relationships (a_id, b_id) VALUES (2, 3);
  `);
  old.close();
  const db = openDb(file);
  const byName = Object.fromEntries(db.listContacts().map((c) => [c.name, c]));
  assert.equal(byName.Prof.role, "Professor");
  assert.equal(byName.Student.role, "PhD");
  assert.equal(byName.Friend.in_network, false);
  assert.equal(byName.Loner.in_network, true);
  assert.ok(!("category" in byName.Prof));
  assert.ok(!("schools" in byName.Prof));
  assert.deepEqual(byName.Prof.orgs.map((o) => o.name), ["McGill", "UBC"]);
  assert.deepEqual(byName.Student.orgs.map((o) => [o.name, o.type]), [["UBC", "School"]]);
  assert.equal(db.listOrgs().length, 2);
});
