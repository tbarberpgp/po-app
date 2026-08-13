# PGP Projects — Design Handoff

Front-end design reference for the **PGP Projects** construction/commercial-management app, rebranded for **PGP Group** (PGP navy + orange, Cambria headings). Light **and** dark mode throughout.

> **About these files:** everything in `/previews` is an HTML **design reference** — intended look, layout and behaviour, built with plain HTML/CSS/JS and inline data. They are **not** production code to copy verbatim. Recreate them in the real codebase (React + TypeScript) using its existing component primitives. Only the **tokens** (`tokens.css`) and the **layout/interaction patterns** described here need to match precisely; the demo class names (`hf-`, ad-hoc utilities) and the "Show notes / Preview state" demo toggles must **not** ship.

---

## ⚠️ Superseded — ignore

- Last week's **Purchase Orders wireframe exploration** (`PGP Purchase Orders.html`) and the old **`design_handoff_po_app/`** folder are **out of date and no longer relevant**. The app has since been built out into the screens below. Do not use them. ("Raise PO" now lives only on the **Materials** tab, not as a global header action.)

---

## How to use with Claude Code

1. Drop this `pgp_handoff/` folder into the repo (e.g. `design/pgp_handoff/`).
2. Add `tokens.css` to global styles **first** — every screen depends on it.
3. Then implement one screen at a time. Example prompt:
   > "Read `design/pgp_handoff/README.md` and `tokens.css`. Open `previews/Dashboard.html` to see the intended result, then build the reporting Dashboard in our React app using our existing components. Show a plan before coding."
4. Open any preview in a browser to see light/dark + interactions. Toggle the demo "Preview state" (Populated/Empty) to see both data states; toggle "Show notes" to read the design rationale — **neither ships**.

---

## Brand & design system

- **Logo:** `assets/pgp-logo.png` (horizontal lockup). 22px tall in the sidebar, 18px in mobile headers. ≥8px clear space.
- **Type:** **Cambria** (brand serif) for headings, KPI values and money; **Inter** (system fallback) for body, labels, table data. Numbers use `tabular-nums`.
- **Tokens:** see `tokens.css` (light + dark). Cards are **flat** — `1px solid var(--pgp-line)`, no shadows.

### Colour discipline (important — applied consistently across every screen)
- **Numbers are never tinted orange.** Orange = CTAs / active state / pending-warning only.
- **Green** = positive financial (profit, savings, certified, paid), signed, on-site, inducted.
- **Amber (warn)** = pending / due / outstanding / expiring / not-inducted.
- **Red (danger)** = rejected, expired, overspend.
- **Deltas are colour-coded by direction** (green ▲ up / red ▼ down) and shown **inline** so they never push the value out of alignment. See the Dashboard "Forecast GP%" column.
- **Status as semantic pills**, KPI labels as **muted eyebrows** (a calm board reads calm — colour only signals something).

### Shared shell
- **Desktop:** 240px sidebar (Workspace + Master Data groups) · main column with topbar (breadcrumb + title + actions) · content. Project pages add a **tab row** (Overview / Commercials / Materials / Operations) and most have a **sub-tab strip**.
- **Theme** persists (localStorage); `data-theme="dark"` on a root element flips everything.

---

## Screen inventory (`/previews`)

| File | What it is | Notes |
|---|---|---|
| `Dashboard.html` | **Reporting dashboard** | Portfolio KPIs → **commercial performance by project** (committed/labour bars, **Contract→Forecast GP% with inline coloured delta**, applied/certified) → Applied & certified vs FFA → Labour by project → Prelims → **H&S/compliance** (drill-downs) → Needs attention → Xero. Filters (Project, Period) populate real options. |
| `Overview.html` | **Project overview** | Enriched "project at a glance": forecast burn bar, **profit delta vs contract (+£ / +% / +pts)**, key dates, on-site Ops KPIs, needs-attention, activity, quick links. No global Raise PO. |
| `Commercials.html` | **Commercials** (sub-tabs: Overview/Prelims/Schedule/Applications/Labour/Variations/Help) | Labour **Live value** = confirmed supplier quote → neutral ink + green/red delta + "QUOTED" tag. Contingency **Save** disabled until changed. Schedule calendar = full month, "Final date for payment" is **navy** (not purple). Prelim-PO empty state guided. |
| `Materials.html` | **Materials** (sub-tabs: Materials/Purchase orders/Help) | Clean toolbar (title + count + "Show full library" toggle + filters). Live price shows green ↓ / red ↑ deltas. **"Raise PO" belongs here.** Blank supplier = "Unassigned". |
| `Operations.html` | **Operations** (sub-tabs: Attendance / Operatives / Briefings & toolbox / Deliveries / RAMS & docs / Progress photos / Plant on site) | See "Operations detail" below. The richest file. |
| `Calendar.html` | **Calendar workspace** | Full month + event chips (coloured left-accent + project tag), today ring, greyed spillover, "Final date for payment" navy, events list. |
| `Applications.html` | **Applications workspace** | Labour / Client tabs. Muted KPI labels; attention metrics go amber only when > 0. Submitted=amber, Certified/Paid=green. |
| `Operatives.html` | **Operatives workspace** | Register (semantic induction/RAMS/cards) → click row opens profile. Profile: induction, phone, profile/RAMS share-link, qualification cards (expired flagged red), **RAMS allocation: pick ONE site → multi-select RAMS** → Send (disabled until a site + ≥1 RAMS chosen). |
| `Admin.html` | **Admin workspace** | Xero integration (3-up connection meta + labelled account-code selects, Save disabled until changed), Users & permissions (role/status pills), Approval thresholds, Approvers. |
| `Deliveries-Mobile.html` | **Mobile delivery check-in flow** | 5 steps: Deliveries list → camera capture of the delivery ticket → scan/extract → **auto-match to a PO (confidence %)** with expected-vs-received qty steppers + short-delivery flag → confirm. Step via the dots. |
| `Mobile-Gallery.html` | **Phone versions of every screen** | The responsive spec made visual — see below. |

---

## Operations detail (`Operations.html`)

- **Attendance** — QR sign-in card + summary stats + **sign-in location map** (pin per signed-in operative, signed-out muted) + roster. Each on-site row has a **Sign out** action; header has **Sign out all** (records who signed them out — supervisor vs self).
- **Operatives** (site-scoped) — assigned-to-site register with induction/cards/RAMS at a glance. Header **"↗ Send RAMS for signature"**; per-row **Send RAMS** for anyone Pending.
- **Briefings & toolbox** — persistent **Daily briefing** (single active, shown & acknowledged at every sign-in; editing resets acknowledgements) + **toolbox-talk log** with acknowledgement tracking; empty state offers roofing templates.
- **Deliveries** — Upcoming (from open POs) + Received (expected-vs-received bars matched to PO). Desktop "Check in a delivery" mirrors the mobile flow.
- **RAMS & docs** — version, category, expiry (amber expiring / red expired), inline signed bar + count, "View all signatures" click-through. **Distribute…** opens a scalable recipient picker: **search + filter chips (All / Pending only / Not inducted) + scrollable checklist + "Select all shown"** — designed to handle large crews (100+), not a chip cloud.
- **Progress photos** — date-grouped gallery with area tags.
- **Plant on site** — per-day **or** per-week rate × time accrual, feeds the Prelims accrual cross-check.

---

## Mobile / responsive spec (`Mobile-Gallery.html`)

Every screen is phone-compatible. Consistent adaptations:
- **Sidebar → bottom tab bar.**
- **Project tabs / sub-tabs → horizontal scrollable strip.**
- **Tables → stacked cards** (one card per row; roster, registers, applications, materials).
- **KPI rows → 2-up grid.**
- **Calendar month grid → agenda list.**
- **Delivery check-in is mobile-first** (camera + ticket OCR + PO match) — see `Deliveries-Mobile.html`.

---

## Implementation notes / gotchas

- **Class-name collisions:** in the prototypes, generic names like `app` and an event class `app` collided with a layout `.app { min-height:100vh }`, and a missing `.hidden{display:none}` rule broke a tab toggle. In the real codebase use scoped/module CSS so these can't happen.
- **Disabled-until-valid buttons:** Contingency Save, Xero "Save account codes", RAMS "Send", and the delivery "Send to N" all stay disabled until their inputs are valid — keep that behaviour.
- **Acknowledgement resets:** editing the active Daily briefing, or pushing a new RAMS version, must re-request signatures.
- **VAT / CIS:** client-invoice VAT follows each project's Application-terms setting (0%/reverse-charge CIS vs 20%) — see Admin + Commercials.
- Existing routes/roles and the Xero + Cloudflare Access integrations are preserved; this is a presentation-layer redesign.

## Files
- `README.md` — this document
- `tokens.css` — design tokens (light + dark) — add to global styles first
- `previews/*.html` — one reference per screen (+ mobile flow & gallery)
- `assets/pgp-logo.png` — brand logo
