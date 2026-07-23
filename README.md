# Ignite Business Manager

Internal business-management app for **Ignite Development LLC** — dashboard,
calendar, tasks, prospects (pipeline), and full finances with reporting. Built on
the same stack as the BlueLine portal: **one Cloudflare Worker** serving both the
static frontend and the JSON API, with **Cloudflare KV** for data.

- **Local dev:** `npm run dev` → http://localhost:8788 (Node 24; no wrangler needed).
- **Logins:** allowlisted owner emails (`will@`, `josh@`, `contact@ignitedevelopment.net`);
  first time, use "Set your password" on the login page.
- **Sample data:** "Load sample data" on the dashboard, or `POST /api/seed`.

See **STATUS.md** for architecture, KV layout, endpoints, and deploy steps.

## Deploy
```
wrangler kv namespace create PORTAL_KV   # paste id into wrangler.toml
wrangler deploy
```
(Windows ARM can't run `wrangler dev` — use `npm run dev` locally and deploy from
CI or an x64/mac machine.)
