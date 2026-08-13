import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { Topbar } from "./Shell";
import { can, outranks, ROLE_LABELS, ROLES, type Role } from "../../shared/permissions";
import type { AppUser, CurrentUser, Settings, SiteGroup } from "../../shared/types";

type ApproverItem = { id: number; project_id: string | null; tier: string; email: string; name: string | null };

export function Admin({ me }: { me: CurrentUser | null }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [approvers, setApprovers] = useState<Awaited<ReturnType<typeof api.listApprovers>>>([]);
  const [projects, setProjects] = useState<Awaited<ReturnType<typeof api.listProjects>>>([]);
  const [users, setUsers] = useState<AppUser[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [approverForm, setApproverForm] = useState({ project_id: "", tier: "line_manager", email: "", name: "" });

  const canManageUsers = can(me?.role, "users.write");
  const canManageApprovers = can(me?.role, "approvers.manage");

  function refresh() {
    api.settings().then(setSettings).catch((e) => setErr(e.message));
    api.listApprovers().then(setApprovers).catch((e) => setErr(e.message));
    api.listProjects().then(setProjects).catch((e) => setErr(e.message));
    if (canManageUsers) api.listUsers().then(setUsers).catch((e) => setErr(e.message));
  }
  useEffect(refresh, [canManageUsers]);

  async function addApprover(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      await api.addApprover({
        project_id: approverForm.project_id || null,
        tier: approverForm.tier,
        email: approverForm.email.trim(),
        name: approverForm.name.trim() || undefined,
      });
      setApproverForm({ project_id: "", tier: "line_manager", email: "", name: "" });
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    }
  }

  return (
    <>
      <Topbar crumbs="Master data" title="Admin" />
      <main>
        {err && <div className="flash error">{err}</div>}

        {canManageApprovers && <XeroSection />}

        {me?.role === "superadmin" && <MailboxPullSection />}

        {canManageUsers && (
          <UsersSection users={users} me={me} onChanged={refresh} />
        )}

        {canManageApprovers && <SitesSection projects={projects} />}

        {can(me?.role, "projects.delete") && <SandboxSection />}

        {canManageApprovers && <CompanyInductionSection />}

        <div className="card card-padded">
          <h2 style={{ marginTop: 0 }}>Approval thresholds</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            PO total value determines the tier when approval is required. Edit the values in
            the <code>settings</code> table to adjust.
          </p>
          {settings && (
            <ul className="thr">
              <li><span className="band num">Up to £{settings.tier_threshold_line_manager.toLocaleString()}</span><span className="arr">→</span><span className="tier">Line Manager</span></li>
              <li><span className="band num">Up to £{settings.tier_threshold_commercial_manager.toLocaleString()}</span><span className="arr">→</span><span className="tier">Commercial Manager</span></li>
              <li><span className="band num">Above £{settings.tier_threshold_commercial_manager.toLocaleString()}</span><span className="arr">→</span><span className="tier">Director</span></li>
              <li><span className="band">Any unpriced</span><span className="arr">→</span><span className="muted">escalates at least to Commercial Manager</span></li>
            </ul>
          )}
        </div>

        <div className="card card-padded">
          <h2 style={{ marginTop: 0 }}>Approvers</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            People listed here receive approval emails and can approve/reject POs in the
            Approvals tab. Edit any row in place.
          </p>
          {canManageApprovers && (
            <form onSubmit={addApprover} className="row" style={{ marginBottom: 16 }}>
              <div>
                <label>Project</label>
                <select value={approverForm.project_id} onChange={(e) => setApproverForm({ ...approverForm, project_id: e.target.value })}>
                  <option value="">All projects (default)</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.code}</option>)}
                </select>
              </div>
              <div>
                <label>Tier</label>
                <select value={approverForm.tier} onChange={(e) => setApproverForm({ ...approverForm, tier: e.target.value })}>
                  <option value="line_manager">Line Manager</option>
                  <option value="commercial_manager">Commercial Manager</option>
                  <option value="director">Director</option>
                </select>
              </div>
              <div className="grow">
                <label>Email</label>
                <input type="email" required value={approverForm.email} onChange={(e) => setApproverForm({ ...approverForm, email: e.target.value })} placeholder="approver@powergridprojects.net" />
              </div>
              <div>
                <label>Name</label>
                <input value={approverForm.name} onChange={(e) => setApproverForm({ ...approverForm, name: e.target.value })} />
              </div>
              <button type="submit" className="primary" style={{ alignSelf: "flex-end" }}>Add</button>
            </form>
          )}
          {approvers.length === 0 ? (
            <div className="muted">No approvers configured yet — POs needing approval will route nowhere.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Scope</th>
                  <th>Tier</th>
                  <th>Name</th>
                  <th>Email</th>
                  <th style={{ width: 110 }}></th>
                </tr>
              </thead>
              <tbody>
                {approvers.map((a) => (
                  <ApproverRow
                    key={a.id}
                    approver={a}
                    projectCode={a.project_id ? projects.find((p) => p.id === a.project_id)?.code ?? a.project_id : null}
                    onSaved={refresh}
                    canManage={canManageApprovers}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </main>
    </>
  );
}

/* ── Sites — group contracts that share a physical site ───────────────────── */

function SitesSection({ projects }: { projects: Array<{ id: string; code: string; name: string }> }) {
  const [groups, setGroups] = useState<SiteGroup[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [base, setBase] = useState("");
  const [busy, setBusy] = useState(false);

  function refresh() { api.opsSiteGroups().then(setGroups).catch((e) => setErr(e.message)); }
  useEffect(refresh, []);

  // A contract can only belong to one site.
  const grouped = new Set(groups.flatMap((g) => g.members.map((m) => m.id)));
  const available = projects.filter((p) => !grouped.has(p.id) || picked.has(p.id));

  function toggle(id: string) {
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      if (base && !n.has(base)) setBase("");
      return n;
    });
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const ids = [...picked];
    if (!name.trim()) return setErr("Name the site.");
    if (ids.length < 2) return setErr("Pick at least two contracts to group.");
    setBusy(true); setErr(null);
    try {
      await api.opsCreateSiteGroup({ name: name.trim(), project_ids: ids, base_project_id: base || ids[0] });
      setName(""); setPicked(new Set()); setBase("");
      refresh();
    } catch (e) { setErr(e instanceof Error ? e.message : "failed"); }
    finally { setBusy(false); }
  }

  async function remove(id: string) {
    if (!confirm("Ungroup this site? The contracts go back to separate sign-in / RAMS / deliveries / programme.")) return;
    try { await api.opsDeleteSiteGroup(id); refresh(); }
    catch (e) { setErr(e instanceof Error ? e.message : "failed"); }
  }

  return (
    <div className="card card-padded">
      <h2 style={{ marginTop: 0 }}>Sites — group contracts</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Bundle contracts that are areas of the same physical site so they share one
        sign-in / QR, one RAMS set, one delivery log and one works programme. Each
        contract keeps its own commercials. The <b>base</b> contract hosts the shared records.
      </p>
      {err && <div className="flash error">{err}</div>}

      <form onSubmit={create} style={{ marginBottom: 16 }}>
        <div className="row" style={{ alignItems: "flex-end" }}>
          <div className="grow"><label>Site name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Dallas Road" />
          </div>
        </div>
        <label style={{ marginTop: 10, display: "block" }}>Contracts in this site</label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "6px 0" }}>
          {available.map((p) => (
            <label key={p.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 10px", border: "1px solid var(--line-strong)", borderRadius: 8, cursor: "pointer", background: picked.has(p.id) ? "var(--accent-soft)" : "var(--card)" }}>
              <input type="checkbox" checked={picked.has(p.id)} onChange={() => toggle(p.id)} />
              <span>{p.code}</span>
            </label>
          ))}
          {available.length === 0 && <span className="muted">No contracts available to group.</span>}
        </div>
        {picked.size >= 2 && (
          <div style={{ marginTop: 6 }}><label>Base contract (hosts the shared sign-in / RAMS / deliveries / programme)</label>
            <select value={base} onChange={(e) => setBase(e.target.value)}>
              <option value="">— first selected —</option>
              {[...picked].map((id) => { const p = projects.find((x) => x.id === id); return <option key={id} value={id}>{p?.code}</option>; })}
            </select>
          </div>
        )}
        <button type="submit" className="primary" disabled={busy || !name.trim() || picked.size < 2} style={{ marginTop: 12 }}>
          {busy ? "Creating…" : "Create site"}
        </button>
      </form>

      {groups.length === 0 ? (
        <div className="muted">No sites grouped yet.</div>
      ) : (
        <table>
          <thead><tr><th>Site</th><th>Contracts</th><th>Base</th><th style={{ width: 90 }}></th></tr></thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.id}>
                <td>{g.name}</td>
                <td>{g.members.map((m) => m.code).join(", ") || "—"}</td>
                <td>{g.members.find((m) => m.id === g.base_project_id)?.code ?? "—"}</td>
                <td><button className="ghost tiny" onClick={() => remove(g.id)}>Ungroup</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/* ── Xero integration ───────────────────────────────────────────────────── */

function XeroSection() {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof api.xeroStatus>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [recheckMsg, setRecheckMsg] = useState<string | null>(null);

  function refresh() {
    api.xeroStatus().then(setStatus).catch((e) => setErr(e.message));
  }
  useEffect(() => {
    refresh();
    // If we came back from the OAuth callback, the URL has ?xero=connected or
    // ?xero_error=… — peel those off and show a notification.
    const url = new URL(window.location.href);
    if (url.searchParams.get("xero") === "connected") {
      url.searchParams.delete("xero");
      window.history.replaceState(null, "", url.toString());
    }
    const xeroErr = url.searchParams.get("xero_error");
    if (xeroErr) {
      setErr(`Xero connect failed: ${xeroErr}`);
      url.searchParams.delete("xero_error");
      window.history.replaceState(null, "", url.toString());
    }
  }, []);

  if (!status) return null;

  async function disconnect() {
    if (!confirm("Disconnect from Xero? You'll need to re-authorise to sync again.")) return;
    setBusy(true); setErr(null);
    try { await api.xeroDisconnect(); refresh(); }
    catch (e) { setErr(e instanceof Error ? e.message : "disconnect failed"); }
    finally { setBusy(false); }
  }

  async function recheckPaid() {
    setBusy(true); setErr(null); setRecheckMsg(null);
    try {
      const r = await api.xeroRecheckPaid();
      setRecheckMsg(
        `Checked ${r.client_checked} client invoice${r.client_checked === 1 ? "" : "s"} (${r.client_marked_paid} newly paid) ` +
        `· scanned ${r.bills_scanned} supplier bill${r.bills_scanned === 1 ? "" : "s"} (${r.bills_marked_paid} newly paid).`,
      );
    } catch (e) { setErr(e instanceof Error ? e.message : "re-check failed"); }
    finally { setBusy(false); }
  }

  return (
    <div className="card card-padded">
      <div className="row" style={{ alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <h2 style={{ margin: 0 }}>Xero integration</h2>
        {status.configured && (status.connected
          ? <span className="pill ok dot">Connected</span>
          : <span className="pill neutral dot">Not connected</span>)}
      </div>
      {err && <div className="flash error">{err}</div>}

      {!status.configured && (
        <div className="muted">
          Xero isn't configured on this environment. An admin needs to:
          <ol style={{ marginTop: 4 }}>
            <li>Register an app at <a href="https://developer.xero.com/myapps" target="_blank" rel="noreferrer">developer.xero.com/myapps</a></li>
            <li>Set the redirect URI to <code style={{ background: "var(--card-2)", padding: "1px 4px", borderRadius: 4 }}>{window.location.origin}/api/xero/callback</code></li>
            <li>From the terminal: <code style={{ background: "var(--card-2)", padding: "1px 4px", borderRadius: 4 }}>npx wrangler secret put XERO_CLIENT_ID</code> and <code style={{ background: "var(--card-2)", padding: "1px 4px", borderRadius: 4 }}>npx wrangler secret put XERO_CLIENT_SECRET</code> using the values from the Xero app</li>
          </ol>
        </div>
      )}

      {status.configured && !status.connected && (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            Not connected. Click below to authorise the app with one of your Xero organisations.
            You'll be redirected to Xero to choose a tenant and approve the requested scopes.
          </p>
          <a href={api.xeroConnectUrl()} className="btn accent">Connect to Xero</a>
        </>
      )}

      {status.configured && status.connected && status.connection && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, marginBottom: 12 }}>
            <div>
              <div className="eyebrow">Organisation</div>
              <div style={{ fontWeight: 500 }}>{status.connection.tenant_name ?? status.connection.tenant_id}</div>
              <div className="muted" style={{ fontSize: 12 }}>{status.connection.tenant_type}</div>
            </div>
            <div>
              <div className="eyebrow">Connected by</div>
              <div style={{ fontSize: 13 }}>{status.connection.connected_by}</div>
              <div className="muted" style={{ fontSize: 12 }}>
                {new Date(status.connection.connected_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
              </div>
            </div>
            <div>
              <div className="eyebrow">Token expires</div>
              <div style={{ fontSize: 13 }}>{new Date(status.connection.expires_at).toLocaleString("en-GB")}</div>
              <div className="muted" style={{ fontSize: 12 }}>auto-refreshes</div>
            </div>
          </div>
          <div className="row">
            <a href={api.xeroConnectUrl()} className="btn ghost">Re-authorise / switch organisation</a>
            <button className="ghost" onClick={recheckPaid} disabled={busy} title="Re-pull paid status from Xero (backstop for any missed webhook)">
              {busy ? "Checking…" : "Re-check paid status now"}
            </button>
            <button className="danger" onClick={disconnect} disabled={busy}>Disconnect</button>
          </div>
          {recheckMsg && <p className="muted" style={{ marginTop: 8, fontSize: 12 }}>{recheckMsg}</p>}
          <p className="muted" style={{ marginTop: 16, fontSize: 12 }}>
            Approved POs are automatically pushed into Xero as draft Purchase Orders for AP to match against incoming invoices.
            Supplier contacts can be synced from the Approved Suppliers page.
          </p>
          <XeroInvoiceConfig />
        </>
      )}
    </div>
  );
}

/** Chart-of-Accounts codes applied when posting to Xero: the revenue account for
 *  client invoices, plus optional expense accounts that pre-code material POs and
 *  subcontractor labour certificates. */
function XeroInvoiceConfig() {
  const [sales, setSales] = useState("");
  const [po, setPo] = useState("");
  const [labour, setLabour] = useState("");
  const [cis, setCis] = useState("");
  const [saved, setSaved] = useState({ sales: "", po: "", labour: "", cis: "" });
  const [accounts, setAccounts] = useState<Array<{ code: string; name: string; type: string; class: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  useEffect(() => {
    api.xeroInvoiceConfig()
      .then((r) => {
        const v = { sales: r.sales_account_code ?? "", po: r.po_account_code ?? "", labour: r.labour_account_code ?? "", cis: r.cis_account_code ?? "" };
        setSaved(v); setSales(v.sales); setPo(v.po); setLabour(v.labour); setCis(v.cis);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : "couldn't load Xero account codes"));
    // Live chart of accounts → turns the code fields into pick-lists. Silent
    // fallback to free-text entry if Xero isn't connected.
    api.xeroAccounts().then((r) => setAccounts(r.accounts ?? [])).catch(() => setAccounts([]));
  }, []);

  async function save() {
    setBusy(true); setErr(null); setOk(false);
    try {
      const r = await api.xeroSetAccounts({
        sales_account_code: sales.trim(),
        po_account_code: po.trim(),
        labour_account_code: labour.trim(),
        cis_account_code: cis.trim(),
      });
      const v = { sales: r.sales_account_code ?? "", po: r.po_account_code ?? "", labour: r.labour_account_code ?? "", cis: r.cis_account_code ?? "" };
      setSaved(v); setSales(v.sales); setPo(v.po); setLabour(v.labour); setCis(v.cis);
      setOk(true); setTimeout(() => setOk(false), 2500);
    } catch (e) { setErr(e instanceof Error ? e.message : "save failed"); }
    finally { setBusy(false); }
  }

  const dirty = sales.trim() !== saved.sales || po.trim() !== saved.po || labour.trim() !== saved.labour || cis.trim() !== saved.cis;
  const codeField = (label: string, hint: string, value: string, set: (v: string) => void, kind: "revenue" | "expense" | "liability", unsetNote?: string) => {
    const wanted = kind === "revenue" ? "REVENUE" : kind === "liability" ? "LIABILITY" : "EXPENSE";
    const opts = accounts.filter((a) => a.class === wanted);
    // Keep showing a saved code even if it isn't in the filtered class list.
    const valueInList = !value || opts.some((a) => a.code === value);
    return (
      <div className="code">
        <div className="ct">{label}</div>
        <div className="cs">{hint}</div>
        {accounts.length > 0 ? (
          <select className="input" value={value} onChange={(e) => set(e.target.value)}>
            <option value="">— not set —</option>
            {!valueInList && value && <option value={value}>{value} (current)</option>}
            {opts.map((a) => <option key={a.code} value={a.code}>{a.code} — {a.name}</option>)}
          </select>
        ) : (
          <input className="input" value={value} onChange={(e) => set(e.target.value)} placeholder="Account code" />
        )}
        {!value.trim() && unsetNote && <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{unsetNote}</div>}
      </div>
    );
  };

  return (
    <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--line)" }}>
      <div className="eyebrow">Xero account codes</div>
      {err && <div className="flash error" style={{ marginTop: 8 }}>{err}</div>}
      <p className="muted" style={{ margin: "4px 0 10px", fontSize: 12 }}>
        Chart-of-Accounts codes applied to the lines we post to Xero — e.g.
        {" "}<code style={{ background: "var(--card-2)", padding: "1px 4px", borderRadius: 4 }}>200</code> Sales,
        {" "}<code style={{ background: "var(--card-2)", padding: "1px 4px", borderRadius: 4 }}>310</code> Cost of goods sold.
      </p>
      <p className="muted" style={{ margin: "0 0 10px", fontSize: 11 }}>
        {accounts.length > 0
          ? "Pick from your Xero chart of accounts (pulled live)."
          : "Connect Xero to pick from your chart of accounts — until then, type the code."}
      </p>
      <div className="codes">
        {codeField(
          "Client invoices (revenue)",
          "Sales/revenue account for certified client applications. Required — invoicing is blocked until set.",
          sales, setSales, "revenue", "not set — client invoicing is blocked",
        )}
        {codeField(
          "Purchase orders (materials)",
          "Expense account pre-coded onto material PO lines. Optional.",
          po, setPo, "expense",
        )}
        {codeField(
          "Labour certificates",
          "Expense account pre-coded onto subcontractor labour-cert lines. Optional.",
          labour, setLabour, "expense",
        )}
        {codeField(
          "CIS deductions (liability)",
          "Where the CIS deduction is posted — what you owe HMRC. Needed only for subcontractors on a 20% / 30% CIS rate.",
          cis, setCis, "liability", "not set — bills for CIS-rated subbies are blocked until set",
        )}
      </div>
      <p className="muted" style={{ margin: "16px 0", fontSize: 12 }}>
        Client-invoice VAT follows each project's setting (Commercials → Application terms): a project on
        {" "}<b>0% / reverse charge (CIS)</b> posts under your org's Domestic Reverse Charge rate, 20% posts as standard.
      </p>
      <div className="row" style={{ alignItems: "center", gap: 8, marginTop: 4 }}>
        <button className="accent" onClick={save} disabled={busy || !dirty}>Save account codes</button>
        {ok && <span className="pill approved">Saved</span>}
      </div>
    </div>
  );
}

/* ── Microsoft Graph mailbox pull ───────────────────────────────────────── */
/** Reads inbound invoice/labour/client emails straight from the M365 mailboxes,
 *  so ingestion doesn't depend on auto-forwarding (which M365 blocks externally).
 *  Dormant until IT sets the MS_GRAPH_* secrets + the mailbox mapping. */
function MailboxPullSection() {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof api.mailboxPullStatus>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  function load() { api.mailboxPullStatus().then(setStatus).catch((e) => setErr(e instanceof Error ? e.message : "couldn't load status")); }
  useEffect(() => { load(); }, []);
  async function run() {
    setBusy(true); setErr(null); setMsg(null);
    try {
      const r = await api.mailboxPullRun();
      setMsg(`Pulled from ${r.mailboxes} mailbox${r.mailboxes === 1 ? "" : "es"} — ${r.fetched} new, ${r.ingested} ingested${r.errors.length ? `; ${r.errors.length} issue(s): ${r.errors.join(" · ")}` : ""}.`);
      load();
    } catch (e) { setErr(e instanceof Error ? e.message : "run failed"); }
    finally { setBusy(false); }
  }
  const last = status?.last_runs?.[0];
  const dt = (s: string) => (s || "").replace("T", " ").slice(0, 16);
  return (
    <div className="card card-padded" style={{ marginBottom: 16 }}>
      <div className="row" style={{ alignItems: "center", gap: 10, marginBottom: 4 }}>
        <h2 style={{ margin: 0 }}>Inbound email — mailbox pull</h2>
        {status && (status.configured
          ? <span className="pill approved">Active</span>
          : <span className="pill" style={{ background: "transparent", border: "1px solid var(--warn)", color: "var(--warn)" }}>Not configured</span>)}
      </div>
      <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
        Reads supplier invoices &amp; subcontractor applications directly from the Microsoft&nbsp;365 mailboxes on a
        schedule (hourly), so ingestion no longer relies on auto-forwarding — which Microsoft blocks externally.
      </p>
      {err && <div className="flash error" style={{ fontSize: 12 }}>{err}</div>}
      {msg && <div className="flash" style={{ fontSize: 12 }}>{msg}</div>}
      {!status?.configured ? (
        <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
          Needs an Entra (Azure&nbsp;AD) app registration with the <b>Mail.Read</b> application permission, scoped to the
          shared mailboxes via an Application Access Policy. Then set the secrets:
          <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 11.5, background: "var(--card-2)", borderRadius: 6, padding: "8px 10px", marginTop: 6, whiteSpace: "pre-wrap", overflowX: "auto" }}>
            wrangler secret put MS_GRAPH_TENANT_ID{"\n"}wrangler secret put MS_GRAPH_CLIENT_ID{"\n"}wrangler secret put MS_GRAPH_CLIENT_SECRET{"\n"}wrangler secret put MS_GRAPH_MAILBOXES{"\n"}{'  # [{"mailbox":"accounts@powergridprojects.net","as":"invoices@pgpprojects.com","folder":"Inbox"}]'}
          </div>
        </div>
      ) : (
        <>
          <div style={{ display: "grid", gap: 4, marginBottom: 10 }}>
            {status.mailboxes.map((m, i) => (
              <div key={i} style={{ fontSize: 12.5 }}><b>{m.mailbox}</b> <span className="muted">/{m.folder}</span> → <span className="pill neutral" style={{ fontSize: 11 }}>{m.as}</span></div>
            ))}
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            {last ? <>Last run {dt(last.ran_at)} — {last.ingested} ingested of {last.fetched} new{last.error ? ` · ⚠ ${last.error}` : ""}. </> : "No runs yet. "}
            {status.total_ingested} messages ingested in total.
          </div>
        </>
      )}
      <div className="row" style={{ gap: 8, marginTop: 12 }}>
        <button className="ghost" disabled={busy || !status?.configured} onClick={run} title={status?.configured ? "Run a pull now instead of waiting for the hourly cron" : "Configure MS_GRAPH_* first"}>
          {busy ? "Pulling…" : "Run pull now"}
        </button>
        <button className="ghost" disabled={busy} onClick={load}>Refresh</button>
      </div>
    </div>
  );
}

/* ── Users section ──────────────────────────────────────────────────────── */

function UsersSection({
  users,
  me,
  onChanged,
}: {
  users: AppUser[];
  me: CurrentUser | null;
  onChanged: () => void;
}) {
  const [form, setForm] = useState<{ email: string; name: string; role: Role }>({
    email: "", name: "", role: "viewer",
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await api.addUser({
        email: form.email.trim(),
        name: form.name.trim() || undefined,
        role: form.role,
      });
      setForm({ email: "", name: "", role: "viewer" });
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  const canPromoteSuper = can(me?.role, "users.promote_superadmin");

  return (
    <div className="card card-padded">
      <h2 style={{ marginTop: 0 }}>Users & permissions</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Anyone past Cloudflare Access lands here as <b>Viewer</b> by default. Promote them to
        Procurement to raise POs, Admin to manage users and projects, or Superadmin for full
        control (incl. deleting POs).
      </p>
      {err && <div className="flash error">{err}</div>}

      <form onSubmit={add} className="row" style={{ marginBottom: 16 }}>
        <div className="grow">
          <label>Email</label>
          <input
            type="email"
            required
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            placeholder="person@powergridprojects.net"
          />
        </div>
        <div className="grow">
          <label>Name</label>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div style={{ minWidth: 160 }}>
          <label>Role</label>
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
            {ROLES.filter((r) => r !== "superadmin" || canPromoteSuper).map((r) => (
              <option key={r} value={r}>{ROLE_LABELS[r]}</option>
            ))}
          </select>
        </div>
        <button type="submit" className="primary" style={{ alignSelf: "flex-end" }} disabled={busy}>Add</button>
      </form>

      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th className="center">Role</th>
            <th className="center">Status</th>
            <th style={{ width: 130 }}></th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <UserRow key={u.email} user={u} me={me} onChanged={onChanged} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UserRow({
  user,
  me,
  onChanged,
}: {
  user: AppUser;
  me: CurrentUser | null;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(user.name ?? "");
  const [role, setRole] = useState<Role>(user.role);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // What this current user is allowed to do to this row.
  const isSelf = me?.email === user.email;
  const isProtected = me ? outranks(user.role, me.role) : true;
  const canEdit = !isProtected;
  const canPromoteSuper = can(me?.role, "users.promote_superadmin");
  const allowedRoles = ROLES.filter((r) => r !== "superadmin" || canPromoteSuper || user.role === "superadmin");

  async function save() {
    setBusy(true); setErr(null);
    try {
      await api.updateUser(user.email, { name: name.trim() || undefined, role });
      setEditing(false);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive() {
    if (!confirm(`${user.active ? "Deactivate" : "Reactivate"} ${user.email}?`)) return;
    await api.updateUser(user.email, { active: !user.active });
    onChanged();
  }

  async function remove() {
    if (!confirm(`Permanently remove ${user.email}? They'll be re-created as a Viewer if they visit again.`)) return;
    await api.removeUser(user.email);
    onChanged();
  }

  if (editing) {
    return (
      <tr style={{ background: "var(--accent-soft)" }}>
        <td><input value={name} onChange={(e) => setName(e.target.value)} /></td>
        <td className="muted">{user.email}{isSelf && " (you)"}</td>
        <td>
          <select value={role} onChange={(e) => setRole(e.target.value as Role)} disabled={isSelf}>
            {allowedRoles.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
          </select>
          {err && <div className="muted" style={{ fontSize: 11, color: "var(--danger)", marginTop: 4 }}>{err}</div>}
        </td>
        <td className="center"><span className={`pill ${user.active ? "approved" : "draft"}`}>{user.active ? "active" : "deactivated"}</span></td>
        <td>
          <button className="primary tiny" onClick={save} disabled={busy}>Save</button>{" "}
          <button className="ghost tiny" onClick={() => { setEditing(false); setName(user.name ?? ""); setRole(user.role); }}>Cancel</button>
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <td>{user.name ?? <span className="muted">—</span>}</td>
      <td className="muted">{user.email}{isSelf && " (you)"}</td>
      <td className="center"><span className={`pill ${user.role === "superadmin" ? "role-su" : user.role === "viewer" ? "" : "role"}`}>{ROLE_LABELS[user.role]}</span></td>
      <td className="center"><span className={`pill ${user.active ? "ok dot" : "draft"}`}>{user.active ? "active" : "deactivated"}</span></td>
      <td>
        {canEdit && <button className="ghost tiny" onClick={() => setEditing(true)}>Edit</button>}{" "}
        {canEdit && !isSelf && (
          <button className="ghost tiny" onClick={toggleActive}>
            {user.active ? "Deactivate" : "Reactivate"}
          </button>
        )}{" "}
        {canEdit && !isSelf && (
          <button className="ghost tiny" onClick={remove}>×</button>
        )}
      </td>
    </tr>
  );
}

/* ── Approver row (unchanged in behaviour, now takes canManage) ────────── */

function ApproverRow({
  approver,
  projectCode,
  onSaved,
  canManage,
}: {
  approver: ApproverItem;
  projectCode: string | null;
  onSaved: () => void;
  canManage: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [email, setEmail] = useState(approver.email);
  const [name, setName] = useState(approver.name ?? "");
  const [tier, setTier] = useState(approver.tier);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await api.updateApprover(approver.id, { email: email.trim(), name: name.trim() || null, tier });
      setEditing(false);
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <tr onDoubleClick={() => canManage && setEditing(true)} style={canManage ? { cursor: "pointer" } : undefined}>
        <td>{projectCode ?? "All"}</td>
        <td>{approver.tier.replace("_", " ")}</td>
        <td>{approver.name ?? <span className="muted">—</span>}</td>
        <td>{approver.email}</td>
        <td>
          {canManage && <button className="ghost tiny" onClick={() => setEditing(true)}>Edit</button>}{" "}
          {canManage && (
            <button
              className="ghost tiny"
              onClick={async () => {
                if (!confirm(`Remove ${approver.email}?`)) return;
                await api.removeApprover(approver.id);
                onSaved();
              }}
            >
              ×
            </button>
          )}
        </td>
      </tr>
    );
  }

  return (
    <tr style={{ background: "var(--accent-soft)" }}>
      <td>{projectCode ?? "All"}</td>
      <td>
        <select value={tier} onChange={(e) => setTier(e.target.value)}>
          <option value="line_manager">Line Manager</option>
          <option value="commercial_manager">Commercial Manager</option>
          <option value="director">Director</option>
        </select>
      </td>
      <td><input value={name} onChange={(e) => setName(e.target.value)} /></td>
      <td><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></td>
      <td>
        <button className="primary tiny" disabled={busy} onClick={save}>Save</button>{" "}
        <button className="ghost tiny" onClick={() => { setEditing(false); setEmail(approver.email); setName(approver.name ?? ""); setTier(approver.tier); }}>Cancel</button>
      </td>
    </tr>
  );
}

/** Create / re-seed the walled-off demo project people can practise in. It never
 *  pushes to Xero or sends real email, is hidden from the dashboard, and resets
 *  to this baseline every night — this button just provisions it now. */
function SandboxSection() {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function reset() {
    setBusy(true); setErr(null); setDone(false);
    try { await api.resetSandbox(); setDone(true); }
    catch (e) { setErr(e instanceof Error ? e.message : "failed"); }
    finally { setBusy(false); }
  }
  return (
    <div className="card card-padded">
      <h2 style={{ marginTop: 0 }}>Demo / sandbox project</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        A safe practice project pre-loaded with a programme, operatives, purchase orders, deliveries,
        sign-ins and a site report. It never pushes to Xero or sends real emails, is excluded from the
        dashboard, and resets to this baseline automatically every night.
      </p>
      {err && <div className="flash error" style={{ marginBottom: 10 }}>{err}</div>}
      {done && <div className="flash success" style={{ marginBottom: 10 }}>Demo project ready — <Link to="/projects/sandbox">open it</Link>.</div>}
      <button className="primary" disabled={busy} onClick={reset}>{busy ? "Resetting…" : "Reset / create demo now"}</button>
    </div>
  );
}

/** Set the standard company induction (one company-wide document). Word docs are
 *  converted to phone-readable HTML in the browser (like RAMS); PDFs upload as-is.
 *  Operatives read it on their profile and self-confirm to become company-inducted. */
function CompanyInductionSection() {
  const [meta, setMeta] = useState<Awaited<ReturnType<typeof api.getCompanyInduction>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function refresh() { api.getCompanyInduction().then(setMeta).catch(() => { /* */ }); }
  useEffect(refresh, []);

  async function upload(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setBusy(true); setErr(null); setMsg(null);
    try {
      const fd = new FormData();
      fd.set("filename", f.name);
      if (/\.docx$/i.test(f.name)) {
        const mod = await import("mammoth");
        const convert = (mod as { convertToHtml?: typeof import("mammoth").convertToHtml }).convertToHtml
          ?? (mod as unknown as { default: typeof import("mammoth") }).default.convertToHtml;
        const { value } = await convert({ arrayBuffer: await f.arrayBuffer() });
        const html = (value || "").replace(/<img[^>]*>/g, ""); // drop inlined base64 images
        if (!html.trim()) throw new Error("Couldn't read that Word document — re-save it as .docx.");
        fd.set("html_content", html);
      } else if (/\.pdf$/i.test(f.name)) {
        fd.set("file", f);
      } else {
        throw new Error("Upload a Word (.docx) or PDF document.");
      }
      await api.setCompanyInduction(fd);
      setMsg("Saved — operatives can now read and confirm the company induction on their profile.");
      setTimeout(() => setMsg(null), 7000);
      refresh();
    } catch (e) { setErr(e instanceof Error ? e.message : "upload failed"); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  }

  return (
    <div className="card card-padded">
      <h2 style={{ marginTop: 0 }}>Company induction</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        The standard company induction every operative completes. Upload a Word (.docx) — read inline on
        their phone — or a PDF. Operatives read it on their profile and confirm, which marks them
        company-inducted (with date). Replacing it here updates it for everyone.
      </p>
      {err && <div className="flash error" style={{ marginBottom: 10 }}>{err}</div>}
      {msg && <div className="flash success" style={{ marginBottom: 10 }}>{msg}</div>}
      {meta?.filename ? (
        <div className="row" style={{ gap: 10, marginBottom: 12, alignItems: "center", flexWrap: "wrap" }}>
          <span className="pill ok">Current: {meta.filename}</span>
          {meta.updated_at && <span className="muted" style={{ fontSize: 12 }}>updated {new Date(meta.updated_at).toLocaleDateString("en-GB")}{meta.updated_by ? ` by ${meta.updated_by}` : ""}</span>}
        </div>
      ) : (
        <div className="muted" style={{ marginBottom: 12 }}>No company induction set yet.</div>
      )}
      <label className="field"><span>{meta?.filename ? "Replace document" : "Upload document"} (.docx or .pdf)</span>
        <input ref={fileRef} className="input" type="file" accept=".docx,.pdf,application/pdf" disabled={busy} onChange={upload} />
      </label>
      {busy && <div className="muted" style={{ fontSize: 12 }}>Uploading…</div>}
    </div>
  );
}
