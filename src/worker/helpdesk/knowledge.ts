// What the helpdesk knows about how the app is used. Hand-written from the
// Guide page (src/client/components/Guide.tsx) because that page is JSX with
// role-conditional rendering and can't be fed to a model as it stands — when
// you change a workflow there, change it here too.
//
// Only user-facing behaviour belongs in this file. Nothing here may be a
// secret, an internal address or an account identifier: the model is told to
// answer from it, so whatever it says, every signed-in user can read.

export const KNOWLEDGE = `
# PGP Projects — how it works

PGP Projects runs each roofing project from one place: site operations and deliveries on the Delivery side, money (pricing, purchase orders, applications) on the Commercial side. Everything starts from Projects — open a project to get its tabs (Overview, Operations, Programme, Reports, Materials, Commercials, Quality).

## Signing in
- Company accounts sign in with their work email. Anyone added with a personal email picks "one-time PIN" and types the code emailed to them — no password.
- Name and role sit at the bottom of the sidebar. If something is missing from the menu, an Admin can change the role under Admin → Users.
- If sign-in shows the wrong person or fails, the usual cause is signing in with a different email from the one registered. Try the registered address.
- The phone home-screen icon and the phone browser keep separate sign-ins, so each asks for its own PIN.
- The app works on phones; the sidebar collapses behind the ☰ button. Light/dark toggle is top-right.
- There is a DEMO project (badged SANDBOX) pre-loaded with data to practise on. It never touches real data, never pushes to Xero or sends emails, and resets overnight.

## Roles
- Superadmin: everything, plus hard deletes, restoring projects, activating pricing uploads, promoting superadmins.
- Admin: users, approvers, master data, full delivery and commercial access. No hard deletes.
- Commercial (the QS seat): pricing workbooks, quotes, POs, applications, variations, suppliers. No delivery-ops editing.
- Project Manager: runs delivery, raises and issues POs. Does not see the commercial position (contract value, forecast, applications, variations).
- Site: deliveries, sign-ins, briefings, RAMS, photos, plant. Nothing commercial.
- Viewer: read-only. New sign-ins start here until an Admin assigns a role.
- Some people have one or two extra permissions granted individually on top of their role (Admin → Users).
- "Approver" is a separate flag on top of any role. It controls money sign-offs by tier (line manager / commercial manager / director) and is set under Admin → Approvers. Being Admin does not make someone an approver, and a missing approver row looks like a broken Approvals screen.

## Delivery workspace
Check in a delivery (Site, PM, Admin):
1. On Projects tap "Check in delivery", or go to the project's Operations tab → Deliveries.
2. Photograph the delivery ticket — the app reads the PO number and line quantities off it.
3. Confirm the site and matched purchase order (or pick manually).
4. Adjust received counts with the − / + steppers if anything is short, add a note, press "Confirm check-in".
5. Short lines are flagged on the PO and the buyer is notified automatically.
A delivery checked in against the whole order (not a line) closes every line on it, so the PO will read as delivered even if the delivery was partial — tick part-delivery / check in by line when it isn't complete.

Site sign-in and attendance: Project → Operations → "Print QR code" for the site entrance. Operatives scan it on their own phones to sign in and out; first-timers register their phone; unknown phones are blocked until an operative profile exists. Sign-in shows the daily briefing and chases unread RAMS. Attendance, briefing acknowledgements and RAMS status live on the Operations tab.

RAMS, briefings and photos: upload RAMS as Word documents — they're converted for phone reading and versioned automatically (a re-upload supersedes the old version and resets who has read it). Set the standing daily briefing on Operations; record toolbox talks against operatives present. Progress photos upload from the same tab.

Plant: "Hire plant" on the Operations tab raises the hire PO and tracks off-hire (reminder emails go out as it approaches). Owned plant transfers between sites from the Plant register; test/inspection dates show status badges before they lapse.

Programme and reports: import the programme Excel on the project's Programme tab — activities draw as a Gantt and link to bill items; linked activities produce a stock demand list you can raise POs from. Reports builds daily/weekly site reports from sign-ins, deliveries, the site WhatsApp group and client emails. "↓ PDF" saves an exact copy; "✎ Edit for client" tailors or hides parts before sending. Emails sent to the projects mailbox are matched to their project and folded into the reports.

## Commercial workspace
A project's money lives in its Commercials and Materials tabs: contract value and cost come from the pricing workbook, committed spend from purchase orders, and the forecast updates as variations, savings and applications land.

Load contract pricing (Commercial, Admin): Project → Materials → "Upload pricing workbook". A superadmin approves the upload before it goes live; it fills the materials BOQ, labour BOQ, prelims and the commercial summary. Re-uploading a revised workbook keeps quote savings already applied.

Quotes and savings (suppliers.manage): upload a supplier quote PDF on the Materials tab — lines auto-match to the BOQ and savings/increases are tracked. Labour-rate quotes upload on the Labour subtab; a rate that increases the budget routes through approval first.

Raise a purchase order (Commercial, PM, Admin):
1. From the project's Materials tab (lines pre-filled from the BOQ with remaining allowances — quantities can't exceed budget) or Purchase Orders → New PO.
2. Tick Framework for a blanket order, or Call-off and search for the framework it draws down against.
3. POs over the threshold route to the right approver tier automatically; the raiser gets an email on approval or rejection.
4. From the PO page: download the PDF, push to Xero, and watch paid status update once Xero pays it.
Default approval tiers by PO value: up to £2,000 line manager; up to £10,000 commercial manager; above that a director. An unpriced line escalates at least to commercial manager. (Admins can change these thresholds, so treat the figures as defaults.)
PO statuses: draft, pending_approval, approved, rejected, issued, deleted. "Issued" means sent to the supplier.

Things that surprise people about POs:
- Editing an approved PO — even saving with no change — sends it back to pending approval for a fresh sign-off.
- The "Notes" on a PO print on the PDF that goes to the supplier. Never put internal commentary there; use internal notes.
- If a material is missing from the PO material picker, it usually has no manufacturer or element set on the project's pricing. Ask Commercial to classify it.
- If the supplier is holding an older copy of an amended order, the PO shows a "superseded copy" warning — re-issue it.
- Deleting a PO is a soft delete that needs a reason; it's visible under the PO list's Deleted filter for those allowed to delete.

Applications for payment: the Applications workspace tracks both directions — applications to the client, and subcontractor labour applications to PGP. Commercial/Admin author client applications on the project's Commercials tab, or inbound email creates them (subcontractors email the labour applications mailbox, certificates the labour certificates mailbox). Everyone with commercial access can read them. Calendar holds the valuation schedule for every project — upload the schedule Excel once.

Variations (Commercial, Admin): register them on the Commercials tab and link the POs and labour they cause. Approved variations roll into the forecast final account.

Approvers: pending POs, price increases and pricing uploads for your tier land in Approvals (badge in the sidebar) and by email. Invoices and labour certificates also have a separate final release sign-off by a named list of people.

## Master data
- Operatives: one profile per person — induction, qualifications (self-uploads need verifying), RAMS reading, sign-in history. Send an operative their profile link from their row.
- Plant register: owned plant, location, test dates.
- Product library: the priced catalogue behind PO lines.
- Approved suppliers: the register every PO checks against; it mirrors Xero contacts, so deleting a supplier here never sticks — hide it instead. Suspended suppliers are flagged on their POs.

## Admin
Users (add by email, pick a role; someone without a company account also needs adding to the access policy, then signs in by one-time PIN), Approvers (who signs off at each tier — grant or remove here, it's data not a deployment), Sites (group blocks sharing one physical site), Xero (connection, account codes, paid-status webhook), Dashboard (portfolio KPIs and cash flow), Deleted projects (superadmins can restore).
`.trim();
