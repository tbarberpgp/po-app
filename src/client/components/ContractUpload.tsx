import { useRef, useState } from "react";
import { api, fmtMoney } from "../lib/api";
import type { Project } from "../../shared/types";

type Extracted = Awaited<ReturnType<typeof api.extractContract>>["extracted"];

/** Field-by-field application of an extracted contract: each populatable
 *  project field gets a checkbox (ticked when the contract states a value that
 *  differs from what's on the project); informational figures (contract sum,
 *  dates) are shown for cross-checking but never written anywhere. */
const APPLY_FIELDS: Array<{
  key: "client" | "client_contact_name" | "client_email" | "payment_terms" | "application_cadence" | "client_retention_pct" | "delivery_address";
  label: string;
  from: (e: Extracted) => string | number | null | undefined;
  current: (p: Project) => string | number | null | undefined;
}> = [
  { key: "client", label: "Client", from: (e) => e.client_name, current: (p) => p.client },
  { key: "client_contact_name", label: "Client contact", from: (e) => e.client_contact_name, current: (p) => p.client_contact_name },
  { key: "client_email", label: "Client email", from: (e) => e.client_email, current: (p) => p.client_email },
  { key: "payment_terms", label: "Client payment terms", from: (e) => e.payment_terms, current: (p) => p.payment_terms },
  { key: "application_cadence", label: "Application cadence", from: (e) => e.application_cadence, current: (p) => p.application_cadence },
  { key: "client_retention_pct", label: "Client retention %", from: (e) => e.retention_pct, current: (p) => p.client_retention_pct },
  { key: "delivery_address", label: "Site / delivery address", from: (e) => e.site_address, current: (p) => p.delivery_address },
];

export function ContractUpload({ project, onApplied }: { project: Project; onApplied: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [extracted, setExtracted] = useState<Extracted | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (fileRef.current) fileRef.current.value = "";
    if (!f) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.extractContract(project.id, f);
      setExtracted(r.extracted);
      // Pre-tick fields where the contract states something the project lacks
      // or contradicts.
      const pre = new Set<string>();
      for (const fld of APPLY_FIELDS) {
        const v = fld.from(r.extracted);
        if (v != null && String(v).trim() && String(v) !== String(fld.current(project) ?? "")) pre.add(fld.key);
      }
      setTicked(pre);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Couldn't read the document");
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!extracted) return;
    setApplying(true); setErr(null);
    try {
      const patch: Record<string, unknown> = {};
      for (const fld of APPLY_FIELDS) {
        if (!ticked.has(fld.key)) continue;
        const v = fld.from(extracted);
        if (v != null && String(v).trim()) patch[fld.key] = v;
      }
      if (Object.keys(patch).length > 0) {
        await api.updateProject(project.id, patch);
        onApplied();
      }
      setExtracted(null);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "failed to apply");
    } finally {
      setApplying(false);
    }
  }

  return (
    <>
      <input ref={fileRef} type="file" accept=".pdf" hidden onChange={onPick} />
      <button className="ghost tiny" disabled={busy} onClick={(e) => { e.stopPropagation(); fileRef.current?.click(); }}
        title="Upload the contract or the client's purchase order — the commercial details are read off it and offered field by field">
        {busy ? "Reading…" : "↑ Read from contract"}
      </button>
      {err && <span className="muted" style={{ color: "var(--danger)", fontSize: 12, marginLeft: 8 }}>{err}</span>}

      {extracted && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(15,17,48,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}
          onClick={() => setExtracted(null)}>
          <div className="card" style={{ maxWidth: 620, width: "calc(100% - 32px)", maxHeight: "calc(100vh - 64px)", overflow: "auto" }}
            onClick={(e) => e.stopPropagation()}>
            <div className="card-hd"><h3 style={{ flex: 1 }}>Read from contract — choose what to apply</h3></div>
            <div className="card-bd">
              <table>
                <thead>
                  <tr><th style={{ width: 30 }}></th><th>Field</th><th>From the document</th><th>Currently on the project</th></tr>
                </thead>
                <tbody>
                  {APPLY_FIELDS.map((fld) => {
                    const v = fld.from(extracted);
                    if (v == null || !String(v).trim()) return null;
                    const cur = fld.current(project);
                    return (
                      <tr key={fld.key}>
                        <td>
                          <input type="checkbox" style={{ minHeight: 0 }} checked={ticked.has(fld.key)}
                            onChange={() => setTicked((prev) => { const n = new Set(prev); if (n.has(fld.key)) n.delete(fld.key); else n.add(fld.key); return n; })} />
                        </td>
                        <td style={{ fontWeight: 500 }}>{fld.label}</td>
                        <td>{String(v)}</td>
                        <td className="muted">{cur != null && String(cur).trim() ? String(cur) : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {(extracted.contract_sum != null || extracted.reference || extracted.start_date || extracted.completion_date) && (
                <div className="muted" style={{ fontSize: 12.5, marginTop: 12, lineHeight: 1.6 }}>
                  Also stated (for cross-checking — not applied):{" "}
                  {extracted.reference && <>ref <b>{extracted.reference}</b> · </>}
                  {extracted.contract_sum != null && <>contract sum <b>{fmtMoney(extracted.contract_sum)}</b> (compare with the pricing workbook total) · </>}
                  {extracted.start_date && <>start <b>{extracted.start_date}</b> · </>}
                  {extracted.completion_date && <>completion <b>{extracted.completion_date}</b></>}
                </div>
              )}
            </div>
            <div className="card-hd" style={{ borderTop: "1px solid var(--line)", borderBottom: "none" }}>
              <div className="grow" />
              <button className="ghost" onClick={() => setExtracted(null)} disabled={applying}>Cancel</button>{" "}
              <button className="accent" onClick={() => void apply()} disabled={applying || ticked.size === 0}>
                {applying ? "Applying…" : `Apply ${ticked.size} field${ticked.size === 1 ? "" : "s"}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
