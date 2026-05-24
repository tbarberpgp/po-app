import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, fmtDate, fmtMoney } from "../lib/api";
import type { MaterialWithCommitment } from "../../shared/types";

export function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const [info, setInfo] = useState<Awaited<ReturnType<typeof api.getProject>> | null>(null);
  const [mats, setMats] = useState<MaterialWithCommitment[]>([]);
  const [filter, setFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function load() {
    if (!id) return;
    api.getProject(id).then(setInfo).catch((e) => setErr(e.message));
    api.listMaterials(id).then(setMats).catch((e) => setErr(e.message));
  }
  useEffect(load, [id]);

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f || !id) return;
    setBusy(true);
    setErr(null);
    try {
      await api.uploadMaterials(id, f);
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "upload failed");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  if (!info) return <div className="muted">Loading…</div>;

  const types = [...new Set(mats.map((m) => m.type))].sort();
  const visible = mats
    .filter((m) => !typeFilter || m.type === typeFilter)
    .filter((m) => !filter || (m.item + (m.manufacturer ?? "")).toLowerCase().includes(filter.toLowerCase()));

  return (
    <>
      <div className="row" style={{ marginBottom: 8 }}>
        <h2 className="grow">{info.project.code} — {info.project.name}</h2>
        <Link className="btn" to={`/projects/${id}/new-po`}>+ Raise PO</Link>
      </div>
      {info.project.client && <p className="muted">Client: {info.project.client}</p>}
      {err && <div className="flash error">{err}</div>}

      <div className="card">
        <div className="row">
          <div className="grow">
            <h3 style={{ margin: 0 }}>Pricing snapshot</h3>
            {info.active_snapshot ? (
              <p className="muted" style={{ marginBottom: 0 }}>
                {info.active_snapshot.filename} — uploaded {fmtDate(info.active_snapshot.uploaded_at)} · {mats.length} materials
              </p>
            ) : (
              <p className="muted" style={{ marginBottom: 0 }}>No pricing workbook uploaded yet.</p>
            )}
          </div>
          <label className="btn secondary" style={{ cursor: "pointer" }}>
            {busy ? "Uploading…" : info.active_snapshot ? "Replace .xlsx" : "Upload .xlsx"}
            <input ref={fileRef} type="file" accept=".xlsx,.xlsm" onChange={onUpload} hidden disabled={busy} />
          </label>
        </div>
      </div>

      {mats.length > 0 && (
        <>
          <div className="row" style={{ margin: "16px 0" }}>
            <input className="grow" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
              <option value="">All types</option>
              {types.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Item</th>
                <th>Manufacturer</th>
                <th className="num">Priced qty</th>
                <th className="num">Committed</th>
                <th className="num">Remaining</th>
                <th className="num">Unit rate</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((m) => {
                const priced = m.total_qty ?? 0;
                const committed = m.committed_qty ?? 0;
                const pct = priced > 0 ? Math.min(100, (committed / priced) * 100) : 0;
                const remaining = m.remaining_qty;
                const over = remaining != null && remaining < 0;
                const nearly = remaining != null && !over && priced > 0 && remaining / priced < 0.1;
                return (
                  <tr key={m.id}>
                    <td>{m.type}</td>
                    <td>{m.item}</td>
                    <td>{m.manufacturer ?? <span className="muted">—</span>}</td>
                    <td className="num">{priced ? `${priced.toLocaleString()} ${m.total_qty_unit ?? ""}` : <span className="muted">not priced</span>}</td>
                    <td className="num">{committed.toLocaleString()}</td>
                    <td className="num">
                      {remaining == null ? (
                        <span className="muted">—</span>
                      ) : (
                        <>
                          <div>{remaining.toLocaleString()} {m.total_qty_unit ?? ""}</div>
                          <div className="bar"><div className={over ? "danger" : nearly ? "warn" : ""} style={{ width: `${pct}%` }} /></div>
                        </>
                      )}
                    </td>
                    <td className="num">{m.unit_rate != null ? fmtMoney(m.unit_rate) : <span className="muted">—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
