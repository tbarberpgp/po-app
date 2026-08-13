import { Topbar } from "./Shell";
import type { CurrentUser } from "../../shared/types";
import { can, ROLE_LABELS } from "../../shared/permissions";

/** Role-aware instructions for every workspace. Static content — each section
 *  only renders if the signed-in user can actually do what it describes, so a
 *  Site user sees delivery flows and nothing commercial. */
export function Guide({ me }: { me: CurrentUser | null }) {
  const role = me?.role;
  const canDelivery = can(role, "delivery.edit");
  const canCommercialView = can(role, "commercial.view");
  const canCommercialEdit = can(role, "commercial.edit");
  const canUpload = can(role, "materials.upload");
  const canPOs = can(role, "pos.create");
  const canSuppliers = can(role, "suppliers.manage");
  const canUsers = can(role, "users.read");
  const isAdmin = role === "admin" || role === "superadmin";

  const toc: Array<[string, string, boolean]> = [
    ["#start", "Getting started", true],
    ["#delivery", "Delivery", true],
    ["#commercial", "Commercial", canCommercialView],
    ["#masterdata", "Master data", canDelivery || canUsers],
    ["#admin", "Admin", isAdmin],
    ["#roles", "Roles", true],
  ];

  return (
    <>
      <Topbar crumbs="Workspace" title="Guide" />
      <main className="guide">
        <div className="card">
          <div className="card-bd">
            <p style={{ margin: 0 }}>
              How PGP Projects works, workspace by workspace. You're signed in as{" "}
              <strong>{me?.name?.trim() || me?.email}</strong> ({role ? ROLE_LABELS[role] : "—"}
              {me?.is_approver ? " · Approver" : ""}), so this page only shows what your role can do.
            </p>
            <div className="guide-toc" style={{ marginTop: 12 }}>
              {toc.filter(([, , show]) => show).map(([href, label]) => <a key={href} href={href}>{label}</a>)}
            </div>
          </div>
        </div>

        <div className="card" id="start">
          <div className="card-hd"><h2>Getting started</h2></div>
          <div className="card-bd">
            <p>
              PGP Projects runs each roofing project from one place: site operations and deliveries on the{" "}
              <strong>Delivery</strong> side, money (pricing, purchase orders, applications) on the{" "}
              <strong>Commercial</strong> side. Everything starts from <strong>Projects</strong> — open a
              project to get its tabs.
            </p>
            <h3>Signing in</h3>
            <ol>
              <li>Open the app address — the login page appears automatically.</li>
              <li>Company accounts sign in with their work email. Anyone added with a personal email picks <em>one-time PIN</em> and types the code sent to their inbox — no password needed.</li>
              <li>Your name and role sit at the bottom of the sidebar. If something you need is missing, an Admin can change your role under Admin → Users.</li>
            </ol>
            <p className="muted-note">
              The app works on phones — the sidebar collapses behind the ☰ button, and delivery check-in is built for one-handed use on site. Light/dark theme toggle is top-right.
            </p>
            <div className="flash info" style={{ marginTop: 12, display: "flex", gap: 10, alignItems: "flex-start" }}>
              <span aria-hidden style={{ fontSize: 16 }}>🧪</span>
              <div>
                <strong>New here? Try the demo.</strong> Open <strong>Projects</strong> and look for the <strong>DEMO</strong> project (badged <em>SANDBOX</em>).
                It's pre-loaded with a programme, operatives, purchase orders, deliveries and a site report so you can click around and try anything —
                raise a PO, check in a delivery, generate a report. It never affects real data, never pushes to Xero or sends emails, and tidies itself up overnight.
              </div>
            </div>
          </div>
        </div>

        <div className="card" id="delivery">
          <div className="card-hd"><h2>Delivery workspace</h2></div>
          <div className="card-bd">
            <p>
              <strong>Projects</strong> lists every live job with who's on site now and what plant is out.
              Open one for its Overview, Operations, Programme and Reports tabs.
            </p>

            {canDelivery && (
              <>
                <h3>Check in a delivery</h3>
                <ol>
                  <li>On <strong>Projects</strong>, tap <em>Check in delivery</em> (works across all sites), or go to the project's Operations tab → Deliveries.</li>
                  <li>Photograph the delivery ticket — the app reads the PO number and line quantities off it.</li>
                  <li>Confirm the site and matched purchase order (or pick them manually).</li>
                  <li>Adjust the received counts with the − / + steppers if anything is short, add a note, and hit <em>Confirm check-in</em>.</li>
                  <li>Short lines are flagged on the PO and the buyer is notified automatically — nothing else to do.</li>
                </ol>

                <h3>Site sign-in &amp; attendance</h3>
                <ol>
                  <li>Project → Operations → <em>Print QR code</em>; put it up at the site entrance.</li>
                  <li>Operatives scan it on their own phones to sign in and out. First-timers register their phone; unknown phones are blocked until an operative profile exists.</li>
                  <li>Sign-in shows the daily briefing to acknowledge, and chases unread RAMS.</li>
                  <li>Attendance (with a sign-in location map), briefing acknowledgements and RAMS status all live on the Operations tab.</li>
                </ol>

                <h3>RAMS, briefings &amp; photos</h3>
                <ol>
                  <li>Upload RAMS as Word documents — the app converts them for reading on a phone and handles revisions automatically (a re-upload supersedes the old version and resets who's read it).</li>
                  <li>Set the standing daily briefing on Operations; record toolbox talks against the operatives present.</li>
                  <li>Progress photos upload from the same tab, grouped by day.</li>
                </ol>

                <h3>Plant</h3>
                <ol>
                  <li><em>Hire plant</em> on the Operations tab raises the hire PO for you and tracks the off-hire date — reminder emails go out as it approaches.</li>
                  <li>Owned plant transfers between sites from the Plant register; test/inspection dates show status badges before they lapse.</li>
                </ol>

                <h3>Programme &amp; reports</h3>
                <ol>
                  <li>Import the programme Excel on the project's Programme tab — activities draw as a Gantt and link to bill items.</li>
                  <li>Linked activities produce a stock demand list{canPOs ? " — raise the PO straight from it" : ""}.</li>
                  <li><strong>Reports</strong> builds daily/weekly site reports from sign-ins, deliveries, the site WhatsApp group and client emails — with the live programme position, a labour table (headcount, hours and trades), visitors, deliveries with their PO and status, and a safety summary. A routine day with nothing to flag is shown as a green "Quiet day" with an all-clear card. <em>↓ PDF</em> saves an exact copy of the on-screen report (select several on the Reports list to export them together); <em>✎ Edit for client</em> lets you tailor or hide bits before sending.</li>
                </ol>
                <p className="muted-note">
                  Anything emailed to <strong>projects@pgpprojects.com</strong> (CC it on client correspondence) is matched to its project and folded into the daily and weekly reports. Emails over 25&nbsp;MB (attachments included) bounce before they reach the system — trim heavy attachments or share a link instead.
                </p>
              </>
            )}
            {!canDelivery && (
              <p className="muted-note">
                Your role is view-only here — you can open any project and read its operations, programme and reports, but check-ins and edits are for Site, PM and Admin roles.
              </p>
            )}
          </div>
        </div>

        {canCommercialView && (
          <div className="card" id="commercial">
            <div className="card-hd"><h2>Commercial workspace</h2></div>
            <div className="card-bd">
              <p>
                A project's money lives in its <strong>Commercials</strong> and <strong>Materials</strong> tabs:
                contract value and cost come from the pricing workbook, committed spend comes from purchase
                orders, and the forecast updates as variations, savings and applications land.
              </p>

              {canUpload && (
                <>
                  <h3>Load the contract pricing</h3>
                  <ol>
                    <li>Project → Materials → <em>Upload pricing workbook</em> (the costing Excel).</li>
                    <li>A superadmin approves the upload before it goes live — it fills the materials BOQ, labour BOQ, prelims and the commercial summary in one pass.</li>
                    <li>Re-uploading a revised workbook keeps the quote savings already applied to purchases.</li>
                  </ol>
                </>
              )}

              {canSuppliers && (
                <>
                  <h3>Quotes &amp; savings</h3>
                  <ol>
                    <li>Upload a supplier quote PDF on the Materials tab — lines auto-match to the BOQ and the savings (or increases) are tracked against budget.</li>
                    <li>Labour-rate quotes upload on the Labour subtab; a rate that increases the budget routes through approval first.</li>
                  </ol>
                </>
              )}

              {canPOs && (
                <>
                  <h3>Raise a purchase order</h3>
                  <ol>
                    <li>From the project's Materials tab (lines pre-filled from the BOQ with remaining allowances — quantities can't exceed budget) or Purchase Orders → <em>New PO</em>.</li>
                    <li>Tick <em>Framework</em> to create a blanket order, or <em>Call-off</em> and search for the framework it draws down against.</li>
                    <li>POs over the threshold route to the right approver tier automatically; you'll get an email on approval or rejection.</li>
                    <li>From the PO page: download the PDF, push to Xero, and watch paid status update once Xero pays it.</li>
                  </ol>
                </>
              )}

              <h3>Applications for payment</h3>
              <ol>
                <li>The <strong>Applications</strong> workspace tracks both directions — applications to the client, and subcontractor labour applications to PGP.</li>
                {canCommercialEdit
                  ? <li>Create a client application on the project's Commercials tab, or let inbound email do it: subcontractors send to <strong>labourapps@</strong>, certificates to <strong>labourcerts@</strong> / <strong>clientcerts@</strong>, client applications go out via <strong>clientapps@pgpprojects.com</strong>.</li>
                  : <li>You can read every application and its certification state, but authoring them is a Commercial/Admin role.</li>}
                <li><strong>Calendar</strong> holds the valuation schedule for every project — upload the schedule Excel once and the key dates appear portfolio-wide.</li>
              </ol>

              {canCommercialEdit && (
                <>
                  <h3>Variations</h3>
                  <ol>
                    <li>Register variations on the Commercials tab; link the POs and labour they cause.</li>
                    <li>Approved variations roll into the Forecast Final Account with their own margin breakdown.</li>
                  </ol>
                </>
              )}

              {me?.is_approver && (
                <p className="muted-note">
                  You're an approver: pending purchase orders, price increases and pricing uploads for your tier
                  land in <strong>Approvals</strong> (badge in the sidebar) and by email.
                </p>
              )}
            </div>
          </div>
        )}

        {(canDelivery || canUsers) && (
          <div className="card" id="masterdata">
            <div className="card-hd"><h2>Master data</h2></div>
            <div className="card-bd">
              <ol>
                {canDelivery && <li><strong>Operatives</strong> — one profile per person: induction, qualifications (self-uploads need verifying), RAMS reading and sign-in history. Send an operative their profile link by email from here, or add many at once with <em>Bulk upload</em> (download the template first) — after importing you choose when to send the invites, and any that don't send are listed by name so you can fix the address and re-send.</li>}
                {canDelivery && <li><strong>Plant register</strong> — owned plant, where it is, and its test dates.</li>}
                {canUsers && <li><strong>Product library</strong> — the priced product catalogue behind PO lines; promote new items from upload suggestions.</li>}
                {canUsers && <li><strong>Approved suppliers</strong> — the register every PO checks against (suspended suppliers are flagged on their POs); syncs contacts with Xero.</li>}
              </ol>
            </div>
          </div>
        )}

        {isAdmin && (
          <div className="card" id="admin">
            <div className="card-hd"><h2>Admin</h2></div>
            <div className="card-bd">
              <ol>
                <li><strong>Users</strong> — add people by email and pick a role (see below). Someone without a company account also needs adding to the Cloudflare Access policy, then they sign in by one-time PIN.</li>
                <li><strong>Approvers</strong> — who signs off at each tier (line manager / commercial manager / director). This is separate from roles.</li>
                <li><strong>Sites</strong> — group blocks that share one physical site so sign-ins, deliveries and RAMS flow to the right place.</li>
                <li><strong>Xero</strong> — the connection, account codes for POs and labour, and the paid-status webhook.</li>
                <li><strong>Dashboard</strong> — portfolio KPIs, cash position and cash-flow charts.</li>
                <li><strong>Deleted projects</strong> — soft-deleted projects wait here; superadmins can restore them.</li>
              </ol>
            </div>
          </div>
        )}

        <div className="card" id="roles">
          <div className="card-hd"><h2>Roles</h2></div>
          <table className="roles-table">
            <thead><tr><th>Role</th><th>What it's for</th></tr></thead>
            <tbody>
              <tr><td>{ROLE_LABELS.superadmin}</td><td>Everything, plus the irreversible bits: deletes, restoring projects, activating pricing uploads, promoting superadmins.</td></tr>
              <tr><td>{ROLE_LABELS.admin}</td><td>Runs the system — users, approvers, master data, plus full delivery and commercial access. No hard deletes.</td></tr>
              <tr><td>{ROLE_LABELS.commercial}</td><td>The QS seat: pricing workbooks, quotes, POs, applications, variations, suppliers. No delivery-ops editing.</td></tr>
              <tr><td>{ROLE_LABELS.pm}</td><td>Runs delivery end-to-end, raises and issues POs, and sees the commercial position read-only.</td></tr>
              <tr><td>{ROLE_LABELS.site}</td><td>Site manager / supervisor: deliveries, sign-ins, briefings, RAMS, photos, plant. Nothing commercial.</td></tr>
              <tr><td>{ROLE_LABELS.viewer}</td><td>Read-only everywhere. New sign-ins start here until an admin assigns a role.</td></tr>
            </tbody>
          </table>
          <div className="card-bd" style={{ paddingTop: 10 }}>
            <p className="muted-note" style={{ margin: 0 }}>
              <strong>Approver</strong> is a separate flag on top of any role — it controls money sign-offs
              (POs, price increases, certifications) by tier, and is managed under Admin → Approvers.
            </p>
          </div>
        </div>
      </main>
    </>
  );
}
