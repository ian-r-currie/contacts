import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCsv } from "./csv.ts";
import { openDb } from "./db.ts";
import { importCsv, normalizeDate, splitNames } from "./importer.ts";

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
  const first = importCsv(db, PEOPLE, { category: "Contact" });
  assert.equal(first.created, 2);
  assert.equal(first.stubs, 2); // Charles Babbage, Mary
  assert.equal(first.relations, 3);

  const ada = db.listContacts().find((c) => c.name === "Ada Lovelace")!;
  assert.equal(ada.follow_up_date, "2026-10-17");
  assert.equal(ada.schools, "Cambridge, UCL");
  assert.equal(ada.notes, "Met at a talk\nVery friendly");
  assert.equal(ada.updated_at.slice(0, 10), "2026-10-07");
  assert.deepEqual(ada.related.map((r) => r.name).sort(), ["Charles Babbage", "Grace Hopper", "Mary"]);

  const second = importCsv(db, PROFS, { category: "Professor" });
  assert.equal(second.merged, 2); // Babbage by name, Mary by website domain
  assert.equal(second.created, 0);
  assert.equal(second.skipped, 1);

  const babbage = db.listContacts().find((c) => c.name === "Charles Babbage")!;
  assert.equal(babbage.category, "Professor");
  assert.equal(babbage.research, "Engines");
  assert.equal(babbage.email, "cb@example.com");
  const mary = db.listContacts().find((c) => c.name === "Mary")!;
  assert.equal(mary.website, "https://www.marysomerville.example.org");

  // Re-importing doesn't duplicate anything.
  importCsv(db, PEOPLE, { category: "Contact" });
  assert.equal(db.listContacts().length, 4);
});

test("a nameless row imported first is renamed when someone references it later", () => {
  const db = openDb(":memory:");
  importCsv(db, PROFS, { category: "Professor" });
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
  assert.deepEqual(db.getContact(a)!.related, [{ id: b, name: "B", note: "colleagues" }]);
  assert.deepEqual(db.getContact(b)!.related, [{ id: a, name: "A", note: "colleagues" }]);
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
