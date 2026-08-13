import { Fragment, useEffect, useMemo, useState } from "react";
import { api, fmtMoney, fmtQty } from "../lib/api";
import type { Variation, MaterialWithCommitment, Product } from "../../shared/types";

/**
 * Variations register for a project. A variation is a cost-centre separate from
 * the contract: a sell value to the client plus material lines (from the
 * project Materials list or the global Product Library) and labour lines.
 * Forecast Final Account = contract value + Σ variation sell values.
 */
export function VariationsView({
  projectId, canEdit, canApprove, contractValue,
}: { projectId: string; canEdit: boolean; canApprove: boolean; contractValue: number }) {
  const [list, setList] = useState<Variation[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Variation | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const toggle = (id: number) => setExpanded((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  function refresh() {
    api.listVariations(projectId).then(setList).catch((e) => setErr(e instanceof Error ? e.message : "load failed"));
  }
  useEffect(() => { refresh(); }, [projectId]);

  async function approve(id: number) {
    try { await api.approveVariation(id); refresh(); }
    catch (e) { setErr(e instanceof Error ? e.message : "approve failed"); }
  }

  const variationsTotal = list.reduce((s, v) => s + (v.sell_value ?? 0), 0);
  const ffa = contractValue + variationsTotal;

  // Planned margin = sell − budgeted material − budgeted labour.
  // Actual margin (to date) = certified revenue − committed material (POs) −
  // certified labour. Roll both up for the footer.
  const planMargin = (v: Variation) => (v.sell_value ?? 0) - (v.material_budget ?? 0) - (v.labour_budget ?? 0);
  const actualMargin = (v: Variation) => (v.revenue_certified ?? 0) - (v.material_spent ?? 0) - (v.labour_spent ?? 0);
  const hasActual = (v: Variation) => (v.revenue_certified ?? 0) > 0 || (v.material_spent ?? 0) > 0 || (v.labour_spent ?? 0) > 0;
  const sum = (f: (v: Variation) => number) => list.reduce((s, v) => s + (f(v) ?? 0), 0);
  const tot = {
    sell: variationsTotal,
    rev: sum((v) => v.revenue_certified ?? 0),
    matBudget: sum((v) => v.material_budget ?? 0),
    matSpent: sum((v) => v.material_spent ?? 0),
    labBudget: sum((v) => v.labour_budget ?? 0),
    labSpent: sum((v) => v.labour_spent ?? 0),
    plan: sum(planMargin),
    actual: sum(actualMargin),
  };
  const anyActual = list.some(hasActual);
  const showActions = canEdit || canApprove;
  const colCount = 7 + (showActions ? 1 : 0);

  async function remove(id: number, no: number) {
    if (!confirm(`Delete variation VO${no}? This removes its material and labour lines.`)) return;
    try { await api.deleteVariation(id); refresh(); }
    catch (e) { setErr(e instanceof Error ? e.message : "delete failed"); }
  }

  return (
    <>
      {err && <div className="flash error">{err}</div>}

      {/* Forecast Final Account */}
      <div className="card">
        <div className="kpis" style={{ gridTemplateColumns: "repeat(3, 1fr)", padding: "16px 20px" }}>
          <div><div className="eyebrow">Contract value</div><div style={{ fontSize: 20, fontWeight: 600, marginTop: 4 }}>{fmtMoney(contractValue)}</div></div>
          <div><div className="eyebrow">Variations</div><div style={{ fontSize: 20, fontWeight: 600, marginTop: 4 }}>{fmtMoney(variationsTotal)}</div></div>
          <div><div className="eyebrow">Forecast Final Account</div><div style={{ fontSize: 20, fontWeight: 700, color: "var(--accent-2)", marginTop: 4 }}>{fmtMoney(ffa)}</div></div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-hd">
          <h2 style={{ flex: 1 }}>Variations</h2>
          {canEdit && !adding && !editing && <button className="accent" onClick={() => setAdding(true)}>+ Add variation</button>}
        </div>

        {(adding || editing) && (
          <VariationForm
            projectId={projectId}
            initial={editing ?? undefined}
            onCancel={() => { setAdding(false); setEditing(null); }}
            onSaved={() => { setAdding(false); setEditing(null); refresh(); }}
          />
        )}

        {list.length === 0 ? (
          <div className="card-bd"><div className="empty">No variations yet. Each variation carries a sell value plus material &amp; labour budgets you can expend against.</div></div>
        ) : (
          <>
          <div className="muted" style={{ padding: "8px 20px 0", fontSize: 12 }}>
            Plan margin uses budgeted material &amp; labour. Actual margin (to date) is certified revenue − committed POs − certified labour.
          </div>
          <table>
            <thead>
              <tr>
                <th style={{ width: 52 }}>VO</th>
                <th>Description</th>
                <th className="num">Sell</th>
                <th className="num">Material</th>
                <th className="num">Labour</th>
                <th className="num">Margin (plan)</th>
                <th className="num">Margin (actual)</th>
                {showActions && <th style={{ width: 40 }}></th>}
              </tr>
            </thead>
            <tbody>
              {list.map((v) => {
                const margin = planMargin(v);
                const pct = (v.sell_value ?? 0) > 0 ? (margin / v.sell_value) * 100 : null;
                const aMargin = actualMargin(v);
                const aPct = (v.revenue_certified ?? 0) > 0 ? (aMargin / v.revenue_certified) * 100 : null;
                const approved = !!v.approved_at;
                const open = expanded.has(v.id);
                // Labour recorded for scope but folded into the existing contract
                // allowance — £0 cost. Show the scope value so it's not invisible.
                const absorbedLabour = v.labour_absorbed ? v.labour.reduce((s, l) => s + (l.value ?? 0), 0) : 0;
                return (
                  <Fragment key={v.id}>
                  <tr>
                    <td style={{ fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }} onClick={() => toggle(v.id)} title="Show materials & labour">
                      <span style={{ display: "inline-block", width: 14, color: "var(--muted)" }}>{open ? "▾" : "▸"}</span>
                      VO{v.variation_no}
                    </td>
                    <td>
                      <span style={{ cursor: "pointer" }} onClick={() => toggle(v.id)}>{v.description}</span>
                      <div style={{ marginTop: 2 }}>
                        {approved
                          ? <span className="muted" style={{ fontSize: 11 }}>✓ Approved</span>
                          : <span style={{ fontSize: 11, fontWeight: 600, color: "#b45309" }}>● Pending approval</span>}
                      </div>
                    </td>
                    <td className="num">
                      {fmtMoney(v.sell_value ?? 0)}
                      {(v.revenue_certified ?? 0) > 0 && (
                        <div className="muted" style={{ fontSize: 11 }}>{fmtMoney(v.revenue_certified)} certified</div>
                      )}
                    </td>
                    <td className="num">
                      {fmtMoney(v.material_budget ?? 0)}
                      {(v.material_spent ?? 0) > 0 && (
                        <div className="muted" style={{ fontSize: 11, color: (v.material_spent ?? 0) > (v.material_budget ?? 0) ? "#b91c1c" : undefined }}>
                          {fmtMoney(v.material_spent)} on POs
                        </div>
                      )}
                    </td>
                    <td className="num">
                      {fmtMoney(v.labour_budget ?? 0)}
                      {v.labour_absorbed ? (
                        <div style={{ marginTop: 2 }}>
                          <span style={{ fontSize: 11, fontWeight: 700, color: "var(--accent-2)" }}>Absorbed</span>
                          {absorbedLabour > 0 && (
                            <div className="muted" style={{ fontSize: 11 }}>{fmtMoney(absorbedLabour)} in contract</div>
                          )}
                        </div>
                      ) : (v.labour_spent ?? 0) > 0 && (
                        <div className="muted" style={{ fontSize: 11, color: (v.labour_spent ?? 0) > (v.labour_budget ?? 0) ? "#b91c1c" : undefined }}>
                          {fmtMoney(v.labour_spent)} certified
                        </div>
                      )}
                    </td>
                    <td className="num" style={{ fontWeight: 600, color: margin < 0 ? "#b91c1c" : "var(--accent-2)" }}>
                      {fmtMoney(margin)}{pct != null ? <span className="muted" style={{ fontWeight: 400, fontSize: 11 }}> ({pct.toFixed(0)}%)</span> : null}
                    </td>
                    <td className="num" style={{ fontWeight: 600, color: hasActual(v) ? (aMargin < 0 ? "#b91c1c" : "var(--accent-2)") : undefined }}>
                      {hasActual(v) ? (
                        <>{fmtMoney(aMargin)}{aPct != null ? <span className="muted" style={{ fontWeight: 400, fontSize: 11 }}> ({aPct.toFixed(0)}%)</span> : null}</>
                      ) : <span className="muted" style={{ fontWeight: 400 }}>—</span>}
                    </td>
                    {showActions && (
                      <td style={{ whiteSpace: "nowrap" }}>
                        {canApprove && !approved && (
                          <><button className="accent tiny" onClick={() => approve(v.id)} title="Approve this variation's budget for expenditure">Approve</button>{" "}</>
                        )}
                        {canEdit && (
                          <>
                            <button className="ghost tiny" onClick={() => setEditing(v)} title="Edit / add materials & labour">Edit</button>{" "}
                            <button className="ghost tiny" onClick={() => remove(v.id, v.variation_no)} title="Delete variation">×</button>
                          </>
                        )}
                      </td>
                    )}
                  </tr>
                  {open && (
                    <tr>
                      <td colSpan={colCount} style={{ background: "var(--card-2)", padding: "12px 20px 16px 34px" }}>
                        {v.materials.length > 0 && (
                          <div style={{ marginBottom: v.labour.length > 0 ? 14 : 0 }}>
                            <div className="eyebrow" style={{ marginBottom: 4 }}>Materials</div>
                            <table>
                              <thead><tr><th>Item</th><th>Manufacturer</th><th className="num">Qty</th><th className="center">Unit</th><th className="num">Rate</th><th className="num">Value</th></tr></thead>
                              <tbody>
                                {v.materials.map((m) => (
                                  <tr key={m.id}>
                                    <td>{m.description}</td>
                                    <td>{m.manufacturer ?? "—"}</td>
                                    <td className="num">{fmtQty(m.qty)}</td>
                                    <td className="center">{m.unit ?? "—"}</td>
                                    <td className="num">{fmtMoney(m.unit_rate)}</td>
                                    <td className="num">{fmtMoney(m.value)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                        {v.labour.length > 0 && (
                          <div>
                            <div className="eyebrow" style={{ marginBottom: 4 }}>
                              Labour
                              {v.labour_absorbed && (
                                <span style={{ fontSize: 11, fontWeight: 600, color: "var(--accent-2)", marginLeft: 8, textTransform: "none", letterSpacing: 0 }}>
                                  — absorbed in contract allowance (£0 cost to project)
                                </span>
                              )}
                            </div>
                            <table>
                              <thead><tr><th>Description</th><th className="num">Qty</th><th className="num">Rate</th><th className="num">Value</th></tr></thead>
                              <tbody>
                                {v.labour.map((l) => (
                                  <tr key={l.id}>
                                    <td>{l.description}</td>
                                    <td className="num">{fmtQty(l.qty)}</td>
                                    <td className="num">{fmtMoney(l.unit_rate)}</td>
                                    <td className="num">{fmtMoney(l.value)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                        {v.materials.length === 0 && v.labour.length === 0 && (
                          <div className="muted">No material or labour lines on this variation.</div>
                        )}
                        {v.notes && <div className="muted" style={{ marginTop: 8 }}>Note: {v.notes}</div>}
                        {!approved && (
                          <div style={{ marginTop: 10, fontSize: 12, color: "#b45309" }}>
                            This variation's budget is awaiting director approval — it can't be expended (PO or labour) until signed off.
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: "2px solid var(--line)", fontWeight: 600 }}>
                <td></td>
                <td>Totals</td>
                <td className="num">
                  {fmtMoney(tot.sell)}
                  {tot.rev > 0 && <div className="muted" style={{ fontSize: 11, fontWeight: 400 }}>{fmtMoney(tot.rev)} certified</div>}
                </td>
                <td className="num">
                  {fmtMoney(tot.matBudget)}
                  {tot.matSpent > 0 && <div className="muted" style={{ fontSize: 11, fontWeight: 400 }}>{fmtMoney(tot.matSpent)} on POs</div>}
                </td>
                <td className="num">
                  {fmtMoney(tot.labBudget)}
                  {tot.labSpent > 0 && <div className="muted" style={{ fontSize: 11, fontWeight: 400 }}>{fmtMoney(tot.labSpent)} certified</div>}
                </td>
                <td className="num" style={{ color: tot.plan < 0 ? "#b91c1c" : "var(--accent-2)" }}>{fmtMoney(tot.plan)}</td>
                <td className="num" style={{ color: anyActual ? (tot.actual < 0 ? "#b91c1c" : "var(--accent-2)") : undefined }}>
                  {anyActual ? fmtMoney(tot.actual) : <span className="muted" style={{ fontWeight: 400 }}>—</span>}
                </td>
                {showActions && <td></td>}
              </tr>
            </tfoot>
          </table>
          </>
        )}
      </div>
    </>
  );
}

type MatLine = { key: string; product_id: number | null; material_id: number | null; description: string; manufacturer: string | null; qty: number; unit: string | null; unit_rate: number; labour_rate?: number };
// matKey links a labour line to the material it was auto-derived from; `auto`
// means its value tracks qty × the material's agreed labour rate until edited.
type LabLine = { key: string; description: string; qty: number; unit_rate: number; matKey?: string; auto?: boolean };

const round2 = (n: number) => Math.round((n ?? 0) * 100) / 100;

function VariationForm({ projectId, initial, onCancel, onSaved }: { projectId: string; initial?: Variation; onCancel: () => void; onSaved: () => void }) {
  const [description, setDescription] = useState(initial?.description ?? "");
  const [sell, setSell] = useState(initial?.sell_value ?? 0);
  const [mat, setMat] = useState<MatLine[]>(
    initial ? initial.materials.map((m) => ({ key: crypto.randomUUID(), product_id: m.product_id, material_id: m.material_id, description: m.description, manufacturer: m.manufacturer, qty: m.qty, unit: m.unit, unit_rate: round2(m.unit_rate) })) : [],
  );
  const [lab, setLab] = useState<LabLine[]>(
    initial ? initial.labour.map((l) => ({ key: crypto.randomUUID(), description: l.description, qty: l.qty ?? 1, unit_rate: round2(l.unit_rate ?? l.value ?? 0) })) : [],
  );
  // "Absorbed" = the labour is done within the existing contract allowance, so it
  // adds £0 to the project. The lines are still recorded for scope.
  const [absorbed, setAbsorbed] = useState(!!initial?.labour_absorbed);
  const [materials, setMaterials] = useState<MaterialWithCommitment[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.listMaterials(projectId).then(setMaterials).catch(() => {});
    api.listProducts().then(setProducts).catch(() => {});
  }, [projectId]);

  // Combined picker: project Materials first (with their agreed labour rate),
  // then the global Product Library (no labour rate).
  const options = useMemo(() => {
    const fromMat = materials.map((m) => ({
      id: `m${m.id}`, label: `${m.item}${m.manufacturer ? ` — ${m.manufacturer}` : ""}`,
      line: { product_id: null as number | null, material_id: m.id, description: m.item, manufacturer: m.manufacturer, unit: m.rate_unit, unit_rate: round2(m.unit_rate ?? 0), labour_rate: round2(m.labour_unit_cost ?? 0) },
    }));
    const fromProd = products.map((p) => ({
      id: `p${p.id}`, label: `${p.description}${p.manufacturer ? ` — ${p.manufacturer}` : ""}  ·  library`,
      line: { product_id: p.id, material_id: null as number | null, description: p.description, manufacturer: p.manufacturer, unit: p.unit, unit_rate: round2(p.unit_cost ?? 0), labour_rate: 0 },
    }));
    return [...fromMat, ...fromProd];
  }, [materials, products]);

  function pickMaterial(optId: string) {
    if (optId === "__blank") { setMat((c) => [...c, { key: crypto.randomUUID(), product_id: null, material_id: null, description: "", manufacturer: null, qty: 1, unit: null, unit_rate: 0 }]); return; }
    const opt = options.find((o) => o.id === optId);
    if (!opt) return;
    const matKey = crypto.randomUUID();
    setMat((c) => [...c, { key: matKey, ...opt.line, qty: 1 }]);
    // A material already on the project carries an agreed labour rate — seed a
    // linked labour line (editable). Products from the library have none.
    if ((opt.line.labour_rate ?? 0) > 0) {
      setLab((c) => [...c, { key: crypto.randomUUID(), matKey, description: `${opt.line.description} — labour`, qty: 1, unit_rate: round2(opt.line.labour_rate ?? 0), auto: true }]);
    }
  }
  const setMatLine = (key: string, patch: Partial<MatLine>) => setMat((c) => c.map((m) => (m.key === key ? { ...m, ...patch } : m)));
  // Changing a material's qty re-derives its linked (un-edited) labour line.
  function setMatQty(key: string, qty: number) {
    setMat((c) => c.map((m) => (m.key === key ? { ...m, qty } : m)));
    // The linked labour line tracks the material qty (its rate stays the agreed rate).
    setLab((c) => c.map((l) => (l.matKey === key && l.auto ? { ...l, qty } : l)));
  }
  const setLabLine = (key: string, patch: Partial<LabLine>) => setLab((c) => c.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const matTotal = mat.reduce((s, m) => s + m.qty * m.unit_rate, 0);
  const labTotal = lab.reduce((s, l) => s + l.qty * l.unit_rate, 0);
  // Absorbed labour costs the project nothing, so it drops out of the margin.
  const labCost = absorbed ? 0 : labTotal;
  const margin = sell - matTotal - labCost;

  async function save() {
    if (!description.trim()) { setErr("Description required"); return; }
    setBusy(true); setErr(null);
    const payload = {
      description: description.trim(),
      sell_value: sell,
      materials: mat.filter((m) => m.description.trim()).map((m) => ({ product_id: m.product_id, material_id: m.material_id, description: m.description.trim(), manufacturer: m.manufacturer, qty: m.qty, unit: m.unit, unit_rate: m.unit_rate })),
      labour: lab.filter((l) => l.description.trim()).map((l) => ({ description: l.description.trim(), qty: l.qty, unit_rate: l.unit_rate })),
      labour_absorbed: absorbed,
    };
    try {
      if (initial) await api.updateVariation(initial.id, payload);
      else await api.createVariation(projectId, payload);
      onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : "save failed"); }
    finally { setBusy(false); }
  }

  const num = { width: 90, textAlign: "right" as const };
  return (
    <div className="card-bd" style={{ borderBottom: "1px solid var(--line)", background: "var(--card-2)", display: "grid", gap: 16 }}>
      {err && <div className="flash error">{err}</div>}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 200px", gap: 16 }}>
        <label>
          <div className="eyebrow">Description</div>
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Additional rooflight" style={{ width: "100%" }} />
        </label>
        <label>
          <div className="eyebrow">Sell value (£)</div>
          <input type="number" step="any" value={sell} onChange={(e) => setSell(Number(e.target.value))} style={{ width: "100%", textAlign: "right" }} />
        </label>
      </div>

      {/* Materials */}
      <div>
        <div className="eyebrow" style={{ marginBottom: 6 }}>Materials</div>
        {mat.length > 0 && (
          <table style={{ marginBottom: 8 }}>
            <thead><tr><th>Item</th><th className="num">Qty</th><th className="center">Unit</th><th className="num">Rate £</th><th className="num">Value</th><th style={{ width: 32 }}></th></tr></thead>
            <tbody>
              {mat.map((m) => (
                <tr key={m.key}>
                  <td><input value={m.description} onChange={(e) => setMatLine(m.key, { description: e.target.value })} style={{ width: "100%" }} placeholder="Material" /></td>
                  <td className="num"><input type="number" step="any" value={m.qty} onChange={(e) => setMatQty(m.key, Number(e.target.value))} style={num} /></td>
                  <td className="center">{m.unit ?? "—"}</td>
                  <td className="num"><input type="number" step="any" value={m.unit_rate} onChange={(e) => setMatLine(m.key, { unit_rate: Number(e.target.value) })} style={num} /></td>
                  <td className="num">{fmtMoney(m.qty * m.unit_rate)}</td>
                  <td><button className="ghost tiny" onClick={() => setMat((c) => c.filter((x) => x.key !== m.key))}>×</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <select value="" onChange={(e) => { pickMaterial(e.target.value); e.currentTarget.value = ""; }} style={{ maxWidth: 420 }}>
          <option value="">+ Add material…</option>
          <option value="__blank">Blank line (type manually)</option>
          {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      </div>

      {/* Labour */}
      <div>
        <div className="eyebrow" style={{ marginBottom: 6 }}>Labour</div>
        {lab.length > 0 && (
          <table style={{ marginBottom: 8 }}>
            <thead><tr><th>Description</th><th className="num">Qty</th><th className="num">Rate £</th><th className="num">Value</th><th style={{ width: 32 }}></th></tr></thead>
            <tbody>
              {lab.map((l) => (
                <tr key={l.key}>
                  <td><input value={l.description} onChange={(e) => setLabLine(l.key, { description: e.target.value })} style={{ width: "100%" }} placeholder="Labour item" /></td>
                  <td className="num"><input type="number" step="any" value={l.qty} onChange={(e) => setLabLine(l.key, { qty: Number(e.target.value), auto: false })} style={num} /></td>
                  <td className="num"><input type="number" step="any" value={l.unit_rate} onChange={(e) => setLabLine(l.key, { unit_rate: Number(e.target.value), auto: false })} style={num} /></td>
                  <td className="num">{fmtMoney(l.qty * l.unit_rate)}</td>
                  <td><button className="ghost tiny" onClick={() => setLab((c) => c.filter((x) => x.key !== l.key))}>×</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <button className="ghost" onClick={() => setLab((c) => [...c, { key: crypto.randomUUID(), description: "", qty: 1, unit_rate: 0 }])}>+ Add labour line</button>
        <label style={{ display: "flex", alignItems: "flex-start", gap: 8, marginTop: 12, cursor: "pointer", fontSize: 13, maxWidth: 620 }}>
          <input type="checkbox" checked={absorbed} onChange={(e) => setAbsorbed(e.target.checked)} style={{ marginTop: 3 }} />
          <span>
            <b>Labour absorbed within the contract allowance</b> — record the labour for scope, but count it as <b>£0 additional cost</b> to the project (margin and Forecast Final Cost treat it as nil).
            {absorbed && labTotal > 0 && (
              <span className="muted"> {fmtMoney(labTotal)} of labour won't be charged to the job.</span>
            )}
          </span>
        </label>
      </div>

      <div className="muted" style={{ fontSize: 12 }}>
        {initial?.approved_at
          ? "Saving changes re-opens this variation for director approval before its budget can be expended again."
          : "This variation needs director sign-off before its budget can be expended (POs or labour)."}
      </div>

      {/* Totals + actions */}
      <div className="row" style={{ alignItems: "center", gap: 24, flexWrap: "wrap" }}>
        <span className="muted">
          Material {fmtMoney(matTotal)} · Labour{" "}
          {absorbed && labTotal > 0
            ? <><s>{fmtMoney(labTotal)}</s> <span style={{ color: "var(--accent-2)", fontWeight: 600 }}>£0 absorbed</span></>
            : fmtMoney(labTotal)}
          {" "}· Margin <b style={{ color: margin < 0 ? "#b91c1c" : "var(--accent-2)" }}>{fmtMoney(margin)}</b>
        </span>
        <span style={{ flex: 1 }} />
        <button className="ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="accent" onClick={save} disabled={busy}>{initial ? `Save VO${initial.variation_no}` : "Save variation"}</button>
      </div>
    </div>
  );
}
