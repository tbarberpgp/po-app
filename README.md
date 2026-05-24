# PowerGrid Purchase Orders

Internal SPA for raising and approving purchase orders against project pricing workbooks.
Runs as a single Cloudflare Worker that serves both the Vite-built React SPA and the Hono API,
backed by Cloudflare D1.

## How it works

1. **Projects** — each construction job is a project. PMs upload the project's pricing
   `.xlsx` (the one with a `Materials` sheet); the worker parses that sheet and stores a
   snapshot of every priced material (item, type, manufacturer, unit rate, **priced qty**).
2. **Raise PO** — a PM picks a project, supplier and one or more lines. Each line has a
   cascading dropdown **Type → Item → Manufacturer (auto-filled)**, plus qty, unit and
   unit cost. They can also add ad-hoc "unpriced" lines.
3. **Auto-approval rules**
   - All lines are priced (in the Materials snapshot) **and** the cumulative qty stays
     within `total_qty` from the snapshot → PO is **auto-approved**.
   - Otherwise it goes to **pending approval** and is routed by total value:
     - `≤ £2,000` → Line Manager
     - `≤ £10,000` → Commercial Manager
     - `> £10,000` → Director
     - Any **unpriced** material escalates at least to Commercial Manager.
   - Thresholds live in the `settings` table — change them in D1.
4. **Email** — Resend notifies the relevant approvers with an in-app link.
5. **Audit** — every create/approve/reject/issue is logged in `audit_log`.

## Stack

- **Cloudflare Worker** with [Static Assets](https://developers.cloudflare.com/workers/static-assets/)
  serving the SPA out of `dist/client` and the API under `/api/*`.
- **Hono** for the API.
- **React 18 + Vite 6** for the SPA.
- **D1** (SQLite at the edge) via `wrangler d1`.
- **Cloudflare Access** for auth — the worker reads the verified email from the
  `Cf-Access-Authenticated-User-Email` header. Locally we fall back to `DEV_USER_EMAIL`.
- **Resend** for transactional email.

## Local development

```bash
# 1. install deps
npm install

# 2. create a local D1 binding and apply migrations
npx wrangler d1 create po_app_db    # copy the printed `database_id` into wrangler.toml
npm run db:migrate:local
npm run db:seed:local                # adds placeholder approvers (optional)

# 3. configure local secrets
cp .dev.vars.example .dev.vars
# edit .dev.vars — set DEV_USER_EMAIL to an email you've also added to `approvers`
# table if you want to test the approval flow.

# 4. run
npm run dev          # Vite dev server on :5173 — proxies /api/* to a local worker
```

> The `@cloudflare/vite-plugin` runs the worker (with the D1 binding) inside Vite, so
> `npm run dev` is the only thing you need.

## Deploy to Cloudflare

```bash
# one-time
npx wrangler login

# create the remote DB (only the first time)
npx wrangler d1 create po_app_db
# copy database_id into wrangler.toml

# migrations & secrets
npm run db:migrate:remote
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put APP_BASE_URL          # https://po.yourdomain.com

# deploy
npm run deploy
```

This deploys a Worker named `po-app`. After the first deploy, in the Cloudflare dashboard:

1. **Workers & Pages → po-app → Settings → Domains & Routes** — add a custom domain
   (e.g. `po.powergridprojects.co.uk`).
2. **Zero Trust → Access → Applications → Add an application → Self-hosted** — protect
   that hostname. Add an Access policy that requires emails from your domain (or specific
   users). Access will inject `Cf-Access-Authenticated-User-Email` on every request.
3. **D1 → po_app_db → Console** — insert real approvers (or use the Admin tab in the app):

```sql
INSERT INTO approvers (tier, email, name) VALUES
  ('line_manager',       'lm@powergridprojects.co.uk',  'Line Manager'),
  ('commercial_manager', 'cm@powergridprojects.co.uk',  'Commercial Manager'),
  ('director',           'dir@powergridprojects.co.uk', 'Director');
```

## GitHub source control

A local git repo is already initialised. To push:

```bash
gh repo create powergrid/po-app --private --source=. --remote=origin --push
# or via the UI; then:
git remote add origin git@github.com:<you>/po-app.git
git push -u origin main
```

To wire continuous deploys on push: in the dashboard, **Workers & Pages → po-app →
Settings → Builds → Connect to Git**, pick the repo, set:

- **Build command:** `npm run build`
- **Deploy command:** `npx wrangler deploy`
- **Root directory:** `/`

## Layout

```
src/
  shared/types.ts            shared between worker and client
  worker/
    index.ts                 Hono app & route mounting
    auth.ts                  Cloudflare Access middleware
    approval.ts              tier logic
    notify.ts                Resend email
    parse-xlsx.ts            Materials sheet parser
    routes/
      projects.ts
      materials.ts
      pos.ts
      approvers.ts
  client/
    App.tsx                  router shell
    components/
      ProjectsList.tsx
      ProjectDetail.tsx      materials table + committed/remaining
      NewPO.tsx              cascading Type→Item→Mfr line editor
      POsList.tsx
      POView.tsx             approve / reject / issue actions
      ApprovalsInbox.tsx
      Admin.tsx              approvers + thresholds
migrations/
  0001_init.sql
  0002_seed.sql              local-dev placeholder approvers
```

## Notes & follow-ups

- xlsx parsing assumes the layout of the BNC001 workbook (Materials sheet, headers on row 5,
  data from row 6, the column map in `parse-xlsx.ts`). If a project's pricing template
  differs the parser will silently skip rows that don't have a value in col A & B.
- "Committed" in the materials view counts qty from POs in `pending_approval`, `approved`,
  and `issued` so allowances reflect outstanding spend.
- The PO numbering is `PO-<PROJECT_CODE>-<0001>` per project — switch the format in
  `nextPONumber` in `src/worker/routes/pos.ts`.
- Notifications use Resend. To switch to Microsoft Graph, replace `src/worker/notify.ts`.
- Auth is intentionally minimal: Cloudflare Access is the gate, and being listed in the
  `approvers` table grants approval rights. Add a `users` table if you ever need richer roles.
```
