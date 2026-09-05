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
6. **Payables → Xero: three acts, and the middle one decides.** Nothing payable
   reaches Xero on one person's say-so. Both routes money leaves by follow the same
   three steps, and the people are deliberately different at each:

   | | 1. Commit for approval | 2. Approve | 3. Push to Xero |
   |---|---|---|---|
   | **who** | Accounts (`commercial.edit`) | a named approver (`release_approvers`) | Accounts (`commercial.edit`) |
   | **supplier invoices** | confirms the 3-way match against the PO and deliveries, then sends it for approval | approves it for payment | creates the draft ACCPAY bill |
   | **labour certificates** | certify the value, then commit for approval | approves it for payment | creates the draft ACCPAY bill |

   **Approving does not post.** It is the decision, and it only unlocks step 3 — the
   push refuses anything unapproved, both on the route and inside the push function
   itself, so no future caller can skip it. Keeping the decision and the posting apart
   is the point: the person who says the money is owed is not the person who puts it
   in the books.

   Overhead invoices have no PO to match, so coding one to a nominal takes the place of
   step 1 — they still need the approval.

   **The two queues** are `GET /api/invoices/queues`, and they drive both dashboards:
   `awaiting` (committed, not yet approved) is the approvers' list, shown as an
   **Invoices** tab on `/approvals`; `ready` (approved, not yet in Xero) is Accounts'
   list, shown as **Ready to push** in `/accounts`. Accounts sees both, so it can see
   what it is waiting on and not just what it can act on.

   Who may approve is a row in **`release_approvers`**, keyed by email — not a role, and
   one list for both payables. It has to be identity, because no role draws the line in
   the right place: the approvers are *some* superadmins and not all of them, and one of
   them works in Accounts as well, so any permission check would either miss an approver
   or hand the decision to people meant only to prepare it. Seeded with `tbarber` and
   `adouty`. To change the list, insert or delete a row:

   ```sql
   INSERT INTO release_approvers (email, name, added_at, added_by)
   VALUES ('someone@powergridprojects.net', 'Their Name', datetime('now'), 'you@…');
   ```

   An empty table means nothing can be pushed to Xero at all — the gate fails closed, and
   so does a database that hasn't had migrations `0118` and `0119` applied.

   Note the three acts are three *stages*, not guaranteed to be three *people*: an
   approver who also has `commercial.edit` can commit a payable and then approve it.
   The audit trail records each act and who performed it, so a self-approval is visible
   after the fact — enforcing it rather than observing it would be a separate change.

   **Column names read a stage early** and predate this flow: `approved_at` is the
   *commit*, `released_at` is the *approval*. `src/shared/payment-release.ts` carries the
   mapping and the predicates both the worker and the client judge these states by.

   Client sales invoices (ACCREC, money *in*) are not covered by this — the gate is about
   money leaving.

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
2a. **Public bypass paths (REQUIRED).** Some routes must be reachable with **no login** —
   the operative-facing pages (token links), their public API, the static bundle they load,
   and the Xero webhook. Add a **second** self-hosted application scoped to these paths with a
   single policy of **Action: Bypass, Include: Everyone**. Access uses *most-specific-path
   precedence*, so this path-scoped app overrides the broad protected app for these paths only
   (no manual ordering needed). Add one `Application domain` row per path **per protected host**
   (the custom domain and, if it's also fronted by Access, `po-app.tbarber.workers.dev`):

   | Path | Why it must be public |
   |------|------------------------|
   | `/operative/*` | Operatives open their profile (induction, RAMS, cards) from a personal token link — no login. |
   | `/site/*`      | Site sign-in page (QR-code token link). |
   | `/cabin/*`     | Cabin QITP — operatives scan a cabin's QR to inspect & sign (token link, no login). |
   | `/pub/*`       | The public API behind the pages above (profile data, sign-in, RAMS, quals, cabin QITP). |
   | `/assets/*`    | The built JS/CSS bundle — without it the public pages can't load. |
   | `/logo.png`    | Brand logo shown on the public pages. |
   | `/webhooks/*`  | Xero paid-status webhook (unauthenticated; verified by HMAC signature instead). |

   If operatives report being asked for an "access code" on a token link, this app is missing
   the matching row — Access is challenging them with its own one-time PIN. Symptom → fix:
   a **profile** link needs `/operative/*`; a **cabin QITP QR** needs `/cabin/*`; a **site
   sign-in** QR needs `/site/*`. Print cabin QR labels only after `/cabin/*` is added, so the
   encoded production URL works on the first scan.

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
