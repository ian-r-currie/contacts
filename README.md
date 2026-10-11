# contacts

A personal contact tracker for keeping up with people you meet: students, professors and anyone else. It replaces the "Contacts" and "Profs" spreadsheet tabs with:

- **A spreadsheet-like table.** Click any cell to edit it. Sort by any column and search everything.
- **Quick add.** Type just a name and press Enter. Fill in the rest later yourself, or let the research agent do it.
- **Real many-to-many relationships.** "Related to" links point at actual contacts. They work in both directions, can carry a note ("met at the HCI social"), and you can create a new person straight from the link box.
- **Network web.** Switch to **Network** to see everyone and their connections. Click a person to highlight who they're connected to, drag nodes around, and scroll or pinch to zoom.
- **People outside your network.** Someone who is only listed as a connection (e.g. a friend of a friend) appears in the web as a hollow dashed node but stays out of your contacts list. Open them and click **Add to my contacts** to bring them in. Adding someone by a name that already exists as a connection does the same.
- **Current school.** With several schools listed, click one to highlight it as their current school. With a single school, that one is current.
- **Last contacted.** A **✓ Contacted today** button also clears a follow-up that has come due.
- **Follow-up reminders.** Due and overdue follow-ups are highlighted, have their own filter, and send a push notification to your browser or phone.
- **Research agent (✦).** Open a contact's side panel and press **Research**. A Claude agent searches the web, fills in empty fields automatically, and lists anything that differs from what you have so you can accept or dismiss it. It also cites its sources. Research keeps running if you close the panel.
- **CSV import and export.** Import maps your sheet's columns and merges by name without overwriting anything.
- **Works on your phone.** The layout is responsive and the app can be installed (PWA).

Your data lives in a local SQLite file (`data/contacts.db`). `data/`, `*.db`, `*.csv` and `.env` are all gitignored, so none of it goes to GitHub.

## Setup

Requires Node.js 22.13 or newer.

```bash
npm install
cp .env.example .env          # then add ANTHROPIC_API_KEY to enable research
npm run build
npm start                     # http://localhost:8787
```

For development with hot reload, use `npm run dev` and open http://localhost:5173.

## Importing your Google Sheet

In Google Sheets, open each tab and choose **File → Download → Comma-separated values**. Then either:

- **In the app:** open **⋯ → Import CSV…**, check the column mapping, and import. Import the Contacts tab first, then Profs.
- **From the command line:**

  ```bash
  npm run import -- ~/Downloads/Planning\ -\ Contacts.csv
  npm run import -- --role Professor ~/Downloads/Planning\ -\ Profs.csv
  ```

What the importer does:

- **Columns.** Name/Professor → Name (a file with a "Professor" column gets role Professor by default), School/Schools → Schools, and Updated → the updated date. "Interest" and "Emailed On" are ignored.
- **Related to.** Each name is linked to the matching contact. A first name alone ("Sam") links to the only person with that first name. Names that match no one are added as people outside your network.
- **Rows without a name but with a website** (like `janedoe.ca`) are matched to the person whose name appears in the domain. Otherwise they are saved as `Unknown (domain)`, and research can find the real name.
- **Merging.** Re-importing, or importing a person who already exists, only fills fields that are empty.

You can delete the CSV files afterwards. The database is the source of truth.

## Research agent

Set `ANTHROPIC_API_KEY` in `.env` and restart the server. The agent uses Claude (`claude-sonnet-5-5`, the latest Sonnet, by default; override it with `RESEARCH_MODEL`) with web search and web fetch. It can fill in name, role, department, schools, research, website and email:

- **Empty fields** are filled automatically.
- **Fields you already have** become suggestions, never silent overwrites.
- **Emails** are only recorded when they are published somewhere; it doesn't guess them.

Every run is saved with its summary and sources in the contact's Research tab. Server-side refusal fallback is enabled, so if a request is declined by a safety classifier, the API retries it on a fallback model instead of failing the run.

## Follow-up notifications

Open **⋯ → Enable follow-up notifications** on each device you want reminders on. Then use **Send test notification** to check that it works.

Starting at `NOTIFY_HOUR` (default 8, server local time; set `TZ` to control the timezone), the server sends one notification per due follow-up, and tapping it opens that contact. Changing a follow-up date re-arms its reminder.

Push notifications need a secure origin: `localhost` works, and anything else needs HTTPS. On iPhone, you must first **Add to Home Screen** from Safari and enable notifications from the installed app.

## Hosting it so your phone can reach it

The server is one Node process plus one SQLite file, so any small host works. **Before exposing it, set `APP_PASSWORD`.** With it set, the app shows a login screen.

- **Easiest and private: [Tailscale](https://tailscale.com).** Keep running the app on your own computer, install Tailscale on it and on your phone, then run `tailscale serve 8787`. You get an HTTPS URL that only your devices can reach, which also makes push notifications work on the phone.
- **Always-on: Docker on a small VPS or Fly.io/Railway.** The included `Dockerfile` stores data in `/data`; mount a persistent volume there.

  ```bash
  docker build -t contacts .
  docker run -d -p 8787:8787 -v contacts-data:/data --env-file .env -e APP_PASSWORD=... contacts
  ```

  Put it behind HTTPS (e.g. Caddy, or the platform's built-in TLS).

**Backups:** copy `data/contacts.db`, or use **⋯ → Export CSV**.

## Project layout

```
server/            Node + Hono API (TypeScript, run with tsx)
  db.ts            SQLite schema and queries (node:sqlite, no native deps)
  importer.ts      CSV import with column mapping and relationship resolution
  research.ts      Research agent (Claude API, web search/fetch, streaming progress)
  notify.ts        Web Push + follow-up scheduler
  auth.ts          Optional password login
web/               React + Vite frontend
  src/components/  Table, network web, side panel, research panel, import dialog
  public/sw.js     Service worker for push notifications
```

`npm test` runs the server tests and `npm run typecheck` type-checks everything.
