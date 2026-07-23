# Ignite Business Manager — Status

**Local path:** `C:\Users\joshu\Documents\ignite-portal`
**Stack:** Single Cloudflare Worker (`worker.js`) serves the static frontend
(`public/`) AND the JSON API, same origin. Data in Cloudflare **KV** (`PORTAL_KV`).
Modeled on the BlueLine portal stack (Worker + KV + static HTML/JS + PBKDF2
sessions). This **replaces** the earlier Next.js + D1 version.

**Owners / logins (allowlisted in `worker.js` `DEFAULT_OWNER_EMAILS`):**
`will@`, `josh@`, `contact@ignitedevelopment.net`. First time, each owner opens
the login page → "Set your password" to create their account (register is gated
to the allowlist; everyone else is 403).

## Architecture
- `worker.js` — router + API. PBKDF2 password hashing, bearer session tokens
  (`session:<token>` → email, 30-day TTL), KV rate limiting, timing-safe compare.
  Non-`/api/*` requests fall through to `env.ASSETS.fetch` (static files).
- `public/index.html` — dark Ignite login (login + first-time password setup).
- `public/app/*.html` — the app: `index.html` (dashboard), `calendar.html`,
  `tasks.html`, `prospects.html`, `finances.html`. Each loads `shared.css` +
  `shared.js` (+ `charts.js` where needed).
- `public/assets/shared.js` — SESSION guard, `api()` fetch wrapper, sidebar shell,
  Ctrl/Cmd-K search palette, money/date formatters, `toast()`, `openModal()`.
- `public/assets/shared.css` — Ignite design system (black sidebar, orange accents,
  off-white workspace; Bebas Neue + DM Sans). Same class vocabulary as BlueLine's.
- `public/assets/charts.js` — dependency-free inline-SVG charts (monthly bars +
  category donut).
- `dev-server.mjs` — local dev server that imports the REAL `worker.js` and shims
  the CF bindings (file-backed KV in `.data/kv.json`, static from `public/`). Runs
  on Node 24 — no `workerd`, so it works on Windows ARM. `npm run dev` → :8788.

## KV layout (all money = integer cents)
```
user:<email>     { name, email, salt, hash, iterations }
session:<token>  email                              (TTL 30d)
rl:<scope>:<ip>  { count, windowStart }             (TTL, rate limiting)
prospect:<id>    { name, company, email, phone, stage, valueCents, source, followUpDate, notes, archived, ... }
task:<id>        { title, notes, owner, prospectId, due, priority, status, archived, ... }
event:<id>       { title, start, end, allDay, location, prospectId, notes, ... }   (hard-deleted)
txn:<id>         { type, amountCents, date, category, description, owner, archived, ... }
invoice:<id>     { number, client, amountCents, status, issueDate, dueDate, paidDate, notes, archived, ... }
asset:<id>       { name, category, purchaseCents, purchaseDate, notes, archived, ... }
```
Financial + CRM records are **archived** (`archived:true`), never hard-deleted;
calendar events are hard-deleted. Transaction types: `revenue`, `expense`,
`asset`, `contribution`, `distribution`. Cash balance =
(revenue + contributions) − (expenses + asset purchases + distributions).

## Endpoints
`POST /api/register|login|logout`, `GET /api/me`, `GET /api/dashboard`,
`GET /api/search?q=`, and full CRUD at
`/api/{prospects,clients,tasks,events,transactions,invoices,assets}` (`GET|POST` on the
collection, `GET|PATCH|DELETE` on `/:id`). Everything except register/login
requires `Authorization: Bearer <token>`.

## Pages
- **Dashboard** — KPI tiles (cash balance, revenue YTD, net YTD, outstanding
  invoices, open tasks, clients, prospects), 6-month revenue/expense/profit
  chart, recent transactions, upcoming tasks + events.
- **Calendar** — month / week / day; click a day to create, click an event to
  edit. Each event has a meeting-prep checklist (topics/documents, checkable);
  events with prep show a 📋 marker.
- **Tasks** — Board view (Trello-style: columns for Joshua Berry / Will
  Bertoncini / Team; drag cards between columns to reassign) and List view,
  toggle persisted per browser. Tasks carry a priority (low/medium/high,
  color-coded on-brand) plus person, due date, done toggle. Click a card/row to
  edit.
- **Clients** — name, company, contact, service, active/inactive toggle, remove;
  click a row to edit.
- **Prospects** — name, company, contact, location, business type, service,
  remove; click a row to edit.
- **Finances** — tabs: Transactions (unified type form + in/out/net), Revenue
  (invoices + mark-paid), Assets (register), Reports (P&L for month/quarter/year/
  all with expense-by-category donut, CSV export, print/PDF).

## Local development
Requires Node.js 24+. No wrangler needed locally.
```
npm run dev          # http://localhost:8788
```
Reset local data: delete the `.data/` folder.

## Deploy to Cloudflare (from a machine with working wrangler, or CI)
1. `wrangler kv namespace create PORTAL_KV` → paste the printed id into
   `wrangler.toml` (`id = "..."`).
2. `wrangler deploy`
3. Each owner opens the site → "Set your password" (allowlisted emails only).
   Set `OWNER_EMAILS` (comma-separated) as a Worker var to change the allowlist.

NOTE (Windows ARM): `wrangler dev` needs `workerd` (no ARM64 build) — that's why
local dev uses `dev-server.mjs` instead. `wrangler deploy` only bundles+uploads,
so deploy from CI (GitHub Actions on Linux) or an x64/mac machine.

## Not yet done / possible next lifts
- Microsoft Graph / SharePoint document integration (stack allows it; not built).
- R2 file storage (binding stubbed in `wrangler.toml`, commented out).
- At-rest encryption of KV records (BlueLine does AES-GCM; not ported here).
- GitHub repo + Actions deploy workflow.
