import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, fmtMoney } from "../lib/api";
import { Topbar } from "./Shell";
import { SupplierCombobox, compareSuppliers, type SupplierOption } from "./SupplierCombobox";
import type { MaterialWithCommitment, Supplier, SupplierStatus } from "../../shared/types";

// Item is "priced for this job" iff total_units > 0 in the Materials sheet (col V).
const isPriced = (m: MaterialWithCommitment) => (m.total_units ?? 0) > 0;

// Top section: tickable rows of items priced for this job.
type PricedRow = {
  material: MaterialWithCommitment;
  qty: number;
};

// Bottom section: items added from the wider materials library OR custom freeform.
type AdditionalRow = {
  key: string;
  source: "library" | "custom";
  // library
  type: string;
  material_id: number | null;
  // shared
  item: string;
  manufacturer: string;
  qty: number;
  unit: string;
  unit_cost: number;
};

const NO_MFR = "(No manufacturer)";

const newAdditional = (): AdditionalRow => ({
  key: crypto.randomUUID(),
  source: "library",
  type: "",
  material_id: null,
  item: "",
  manufacturer: "",
  qty: 0,
  unit: "",
  unit_cost: 0,
});

export function NewPO() {
  const { id: projectId } = useParams<{ id: string }>();
  const nav = useNavigate();
  const [project, setProject] = useState<Awaited<ReturnType<typeof api.getProject>> | null>(null);
  const [mats, setMats] = useState<MaterialWithCommitment[]>([]);
  const [approvedSuppliers, setApprovedSuppliers] = useState<Supplier[]>([]);
  const [supplier, setSupplier] = useState<string>("");
  const [customSupplier, setCustomSupplier] = useState<string>("");
  const [notes, setNotes] = useState("");
  const [deliveryDate, setDeliveryDate] = useState("");
  const [pricedRows, setPricedRows] = useState<Map<number, PricedRow>>(new Map());
  const [additional, setAdditional] = useState<AdditionalRow[]>([]);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) return;
    api.getProject(projectId).then(setProject).catch((e) => setErr(e.message));
    api.listMaterials(projectId).then(setMats).catch((e) => setErr(e.message));
    api.listSuppliers().then(setApprovedSuppliers).catch(() => setApprovedSuppliers([]));
  }, [projectId]);

  // Index approved suppliers by lowercased name for O(1) match.
  const approvedByName = useMemo(() => {
    const m = new Map<string, Supplier>();
    for (const s of approvedSuppliers) m.set(s.name.toLowerCase(), s);
    return m;
  }, [approvedSuppliers]);

  function findApprovedSupplier(name: string): Supplier | null {
    return approvedByName.get(name.trim().toLowerCase()) ?? null;
  }

  // Suppliers shown in the dropdown = union of manufacturers in this project's
  // snapshot AND the org-level approved suppliers register, each tagged with
  // its register status (or "not_in_register" for ad-hoc snapshot manufacturers).
  const suppliers = useMemo(() => {
    const set = new Map<string, { priced: number; total: number }>();
    for (const m of mats) {
      const key = m.manufacturer?.trim() || NO_MFR;
      const cur = set.get(key) ?? { priced: 0, total: 0 };
      cur.total += 1;
      if (isPriced(m)) cur.priced += 1;
      set.set(key, cur);
    }
    // Make sure approved suppliers also appear even if they have no priced items.
    for (const s of approvedSuppliers) {
      if (!set.has(s.name)) set.set(s.name, { priced: 0, total: 0 });
    }
    return [...set.entries()]
      .map(([name, v]) => {
        const approved = findApprovedSupplier(name);
        const status: SupplierStatus | "not_in_register" = approved?.status ?? "not_in_register";
        return { name, ...v, status, approved };
      })
      .filter((s) => s.name !== NO_MFR || s.priced > 0 || s.total > 0)
      .sort((a, b) => {
        // Preferred first, then by priced count desc, then alphabetical.
        const rank = (s: SupplierStatus | "not_in_register") =>
          s === "preferred" ? 0 : s === "approved" ? 1 : s === "pending" ? 2 : s === "suspended" ? 4 : 3;
        if (a.status !== b.status) return rank(a.status) - rank(b.status);
        if (a.priced !== b.priced) return b.priced - a.priced;
        return a.name.localeCompare(b.name);
      });
  }, [mats, approvedSuppliers, approvedByName]);

  const isCustomSupplier = supplier === "__other__";
  const effectiveSupplier = isCustomSupplier
    ? customSupplier.trim()
    : supplier === NO_MFR
      ? ""
      : supplier;
  const supplierRecord = effectiveSupplier ? findApprovedSupplier(effectiveSupplier) : null;

  // Top section data: priced items (V > 0) for this supplier.
  const pricedForSupplier = useMemo(() => {
    if (!supplier || isCustomSupplier) return [];
    return mats
      .filter(isPriced)
      .filter((m) => (supplier === NO_MFR ? !m.manufacturer : m.manufacturer === supplier))
      .filter((m) => !filter || (m.item + (m.type ?? "")).toLowerCase().includes(filter.toLowerCase()));
  }, [mats, supplier, isCustomSupplier, filter]);

  // Bottom section: items in the database NOT priced for this job (V is null/0),
  // restricted to the chosen supplier (= manufacturer) so the whole PO is from one place.
  const libraryUnpriced = useMemo(() => {
    if (!supplier || isCustomSupplier) return [];
    return mats
      .filter((m) => !isPriced(m))
      .filter((m) => (supplier === NO_MFR ? !m.manufacturer : m.manufacturer === supplier));
  }, [mats, supplier, isCustomSupplier]);
  const libraryTypes = useMemo(
    () => [...new Set(libraryUnpriced.map((m) => m.type))].sort(),
    [libraryUnpriced],
  );

  // Reset rows when supplier changes — selections are supplier-scoped.
  useEffect(() => {
    setPricedRows(new Map());
    setAdditional([]);
    setFilter("");
  }, [supplier]);

  function toggleRow(m: MaterialWithCommitment) {
    setPricedRows((prev) => {
      const next = new Map(prev);
      if (next.has(m.id)) {
        next.delete(m.id);
      } else {
        const remaining = Math.max(0, (m.total_units ?? 0) - (m.committed_qty ?? 0));
        next.set(m.id, { material: m, qty: remaining });
      }
      return next;
    });
  }
  function setPricedQty(id: number, qty: number) {
    setPricedRows((prev) => {
      const next = new Map(prev);
      const row = next.get(id);
      if (row) next.set(id, { ...row, qty });
      return next;
    });
  }

  function addAdditional() {
    // If there's no library to pick from (custom supplier, or supplier with no
    // unpriced items), drop straight into custom-entry mode.
    const startCustom = libraryUnpriced.length === 0;
    setAdditional((a) => [
      ...a,
      startCustom
        ? { ...newAdditional(), source: "custom", manufacturer: effectiveSupplier }
        : newAdditional(),
    ]);
  }
  function updateAdditional(key: string, patch: Partial<AdditionalRow>) {
    setAdditional((a) => a.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }
  function removeAdditional(key: string) {
    setAdditional((a) => a.filter((r) => r.key !== key));
  }

  function pickLibraryItem(key: string, materialIdStr: string) {
    if (materialIdStr === "__custom__") {
      updateAdditional(key, {
        source: "custom",
        material_id: null,
        item: "",
        manufacturer: effectiveSupplier,
        unit: "",
        unit_cost: 0,
      });
      return;
    }
    const m = libraryUnpriced.find((mm) => String(mm.id) === materialIdStr);
    if (!m) return;
    updateAdditional(key, {
      source: "library",
      material_id: m.id,
      item: m.item,
      manufacturer: m.manufacturer ?? "",
      unit: m.total_units_unit ?? m.pack_unit ?? "ea",
      unit_cost: m.cost ?? 0,
    });
  }

  // Totals
  const pricedSelected = useMemo(() => [...pricedRows.values()].filter((r) => r.qty > 0), [pricedRows]);
  const pricedTotal = pricedSelected.reduce((s, r) => s + r.qty * (r.material.cost ?? 0), 0);
  const validAdditional = additional.filter((a) => a.item.trim() && a.qty > 0);
  const additionalTotal = validAdditional.reduce((s, a) => s + a.qty * a.unit_cost, 0);
  const grandTotal = pricedTotal + additionalTotal;

  const overBudget = pricedSelected.filter((r) => {
    const rem = (r.material.total_units ?? 0) - (r.material.committed_qty ?? 0);
    return r.qty > rem;
  });
  const hasOver = overBudget.length > 0;
  const hasAdditional = validAdditional.length > 0;
  const needsApproval = hasOver || hasAdditional;

  // Scope checks against the approved supplier register. Surfaced as warnings
  // — they don't block submission, but they nudge the PM to use the right
  // merchant for the right element (e.g. don't buy insulation off a flashings-only
  // supplier).
  const scopeWarnings = useMemo(() => {
    if (!supplierRecord) return [];
    if (supplierRecord.approved_elements.length === 0) return []; // no scope = any element
    const ok = new Set(supplierRecord.approved_elements);
    const out: Array<{ item: string; element_code: string }> = [];
    for (const r of pricedSelected) {
      const ec = r.material.product_element_code;
      if (ec && !ok.has(ec)) out.push({ item: r.material.item, element_code: ec });
    }
    return out;
  }, [supplierRecord, pricedSelected]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!projectId) return;
    if (!effectiveSupplier) return setErr("Pick a supplier (or enter a custom one).");
    if (pricedSelected.length === 0 && validAdditional.length === 0) {
      return setErr("Tick at least one priced item or add an additional item.");
    }
    setBusy(true);
    setErr(null);
    try {
      const lines = [
        ...pricedSelected.map((r) => ({
          material_id: r.material.id,
          item: r.material.item,
          type: r.material.type,
          manufacturer: r.material.manufacturer,
          qty: r.qty,
          unit: r.material.total_units_unit ?? r.material.pack_unit ?? "ea",
          unit_cost: r.material.cost ?? 0,
        })),
        ...validAdditional.map((a) => ({
          material_id: a.material_id,           // null for custom, set for library picks
          item: a.item.trim(),
          type: a.type || null,
          manufacturer: a.manufacturer.trim() || null,
          qty: a.qty,
          unit: a.unit || "ea",
          unit_cost: a.unit_cost,
        })),
      ];
      const res = await api.createPO({
        project_id: projectId,
        supplier: effectiveSupplier,
        notes: notes.trim() || undefined,
        delivery_date: deliveryDate || undefined,
        lines,
      });
      nav(`/pos/${res.id}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  // Budget context for the inspector — sum priced and committed material values.
  const budget = useMemo(() => {
    let priced = 0, committed = 0;
    for (const m of mats) {
      const cost = m.cost ?? 0;
      priced += (m.total_units ?? 0) * cost;
      committed += (m.committed_qty ?? 0) * cost;
    }
    return { priced, committed };
  }, [mats]);
  const projectedCommitted = budget.committed + pricedTotal; // additional items don't reduce the priced budget

  // Live preview of approval tier — mirrors src/worker/approval.ts logic
  const tierPreview = !needsApproval
    ? null
    : grandTotal <= 2000 && !hasAdditional
      ? "Line Manager"
      : grandTotal <= 10000
        ? "Commercial Manager"
        : "Director";

  if (!project) return <main className="muted">Loading…</main>;

  return (
    <>
      <Topbar
        crumbs={<><Link to="/">Projects</Link> / <Link to={`/projects/${projectId}`}>{project.project.code}</Link> / New PO</>}
        title="New Purchase Order"
        actions={
          <>
            <Link to={`/projects/${projectId}`} className="btn ghost">Cancel</Link>
            <button
              type="submit"
              form="new-po-form"
              className="accent"
              disabled={busy || grandTotal <= 0}
            >
              {busy ? "Submitting…" : needsApproval ? "Submit for approval" : "Create PO"}
            </button>
          </>
        }
      />
      <main>
      {err && <div className="flash error">{err}</div>}

      {effectiveSupplier && supplierRecord?.status === "suspended" && (
        <div className="flash error">
          <b>{effectiveSupplier}</b> is currently <b>suspended</b>. Speak to admin before raising a PO with this supplier.
        </div>
      )}
      {effectiveSupplier && supplierRecord?.status === "pending" && (
        <div className="flash info">
          <b>{effectiveSupplier}</b> is in onboarding (pending). Credit terms may not be set up yet — check before issuing.
        </div>
      )}
      {effectiveSupplier && !supplierRecord && !isCustomSupplier && (
        <div className="flash info">
          <b>{effectiveSupplier}</b> isn't in your <Link to="/suppliers">approved suppliers</Link> register yet.
          Adding them there gives you payment terms, scope, contact details, and lets you preference them in future POs.
        </div>
      )}
      {scopeWarnings.length > 0 && (
        <div className="flash info">
          <b>{scopeWarnings.length} item{scopeWarnings.length === 1 ? "" : "s"} outside supplier's approved scope.</b>{" "}
          {effectiveSupplier} is approved for elements {supplierRecord!.approved_elements.join(", ")} only.
          Items affected: {scopeWarnings.slice(0, 3).map((w) => `${w.item} (${w.element_code})`).join(", ")}
          {scopeWarnings.length > 3 && ` (+${scopeWarnings.length - 3} more)`}.
        </div>
      )}

      <form id="new-po-form" onSubmit={submit}>
        <div className="split">
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {/* Supplier selection */}
        <div className="card card-padded">
          <div className="row">
            <div style={{ minWidth: 320, flex: "1 1 320px" }}>
              <label>Supplier</label>
              <SupplierCombobox
                value={supplier === "__other__" ? "" : supplier}
                isCustom={isCustomSupplier}
                onChange={(name) => setSupplier(name)}
                onCustom={() => setSupplier("__other__")}
                onProject={[...suppliers.filter((s) => s.priced > 0 || s.total > 0)].sort(compareSuppliers) as SupplierOption[]}
                offProject={[...suppliers.filter((s) => s.priced === 0 && s.total === 0)].sort(compareSuppliers) as SupplierOption[]}
              />
              {supplierRecord && (
                <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                  {supplierRecord.payment_terms && <>Terms: {supplierRecord.payment_terms} · </>}
                  {supplierRecord.approved_elements.length > 0
                    ? `Scope: ${supplierRecord.approved_elements.join(", ")}`
                    : "Scope: any element"}
                </div>
              )}
            </div>
            {isCustomSupplier && (
              <div className="grow">
                <label>Custom supplier name</label>
                <input value={customSupplier} onChange={(e) => setCustomSupplier(e.target.value)} placeholder="e.g. SIG Roofing" />
              </div>
            )}
            <div style={{ minWidth: 160 }}>
              <label>Delivery date</label>
              <input type="date" value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)} />
            </div>
          </div>
          <div style={{ marginTop: 12 }}>
            <label>Notes</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} style={{ width: "100%" }} />
          </div>
        </div>

        {/* TOP: priced items for this supplier */}
        {supplier && !isCustomSupplier && (
          <div className="card">
            <div className="card-hd">
              <h2 style={{ flex: 1 }}>
                Priced items <span className="muted" style={{ fontWeight: 400, fontFamily: "var(--font-sans)", fontSize: 13 }}>from {supplier}</span>
              </h2>
              <input placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 220 }} />
              <span className="muted">{pricedSelected.length} selected · {fmtMoney(pricedTotal)}</span>
            </div>
            {pricedForSupplier.length === 0 ? (
              <div className="card-bd"><div className="muted">
                No items priced for this job from {supplier}. Use the “Additional items” section below.
              </div></div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 36 }}></th>
                    <th>Item</th>
                    <th className="center">Type</th>
                    <th className="num">Pack cost</th>
                    <th className="center">Unit</th>
                    <th className="num">Priced</th>
                    <th className="num">Committed</th>
                    <th className="num">Remaining</th>
                    <th className="num" style={{ width: 110 }}>Order qty</th>
                    <th className="num">Line total</th>
                  </tr>
                </thead>
                <tbody>
                  {pricedForSupplier.map((m) => {
                    const row = pricedRows.get(m.id);
                    const unit = m.total_units_unit ?? m.pack_unit ?? "ea";
                    const priced = m.total_units ?? 0;
                    const committed = m.committed_qty ?? 0;
                    const remaining = priced - committed;
                    const lineTotal = row ? row.qty * (m.cost ?? 0) : 0;
                    const isOver = row && row.qty > remaining;
                    return (
                      <tr key={m.id} style={row ? { background: "var(--accent-soft)" } : undefined}>
                        <td><input type="checkbox" checked={!!row} onChange={() => toggleRow(m)} /></td>
                        <td>{m.item}</td>
                        <td className="center">{m.type}</td>
                        <td className="num">{m.cost != null ? fmtMoney(m.cost) : <span className="muted">—</span>}</td>
                        <td className="center">{unit}</td>
                        <td className="num">{priced.toLocaleString()}</td>
                        <td className="num">{committed.toLocaleString()}</td>
                        <td className="num">{remaining.toLocaleString()}</td>
                        <td className="num">
                          {row ? (
                            <input
                              type="number" step="any" min={0}
                              value={row.qty || ""}
                              onChange={(e) => setPricedQty(m.id, Number(e.target.value))}
                              style={{ width: 90, textAlign: "right" }}
                            />
                          ) : <span className="muted">—</span>}
                        </td>
                        <td className="num">
                          {row ? (
                            <>
                              {fmtMoney(lineTotal)}
                              {isOver && <div><span className="badge over" style={{ marginTop: 4 }}>over</span></div>}
                            </>
                          ) : <span className="muted">—</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* BOTTOM: additional / unpriced items — cascading Type→Item picker */}
        {(supplier || isCustomSupplier) && (
          <div className="card">
            <div className="card-hd">
              <div className="grow">
                <h2 style={{ margin: 0 }}>Additional items</h2>
                <div className="muted" style={{ marginTop: 4 }}>Anything not priced in the BOQ for this job — picked from the materials library, or custom.</div>
              </div>
              <button type="button" className="ghost" onClick={addAdditional}>+ Add item</button>
            </div>
            <div className="card-bd">
              {additional.length === 0 ? (
                <div className="muted">None yet.</div>
              ) : (
                additional.map((row, idx) => (
                  <AdditionalRowEditor
                    key={row.key}
                    row={row}
                    idx={idx}
                    libraryTypes={libraryTypes}
                    library={libraryUnpriced}
                    onChange={(p) => updateAdditional(row.key, p)}
                    onPick={(v) => pickLibraryItem(row.key, v)}
                    onRemove={() => removeAdditional(row.key)}
                  />
                ))
              )}
            </div>
          </div>
        )}
          </div>

          {/* Right inspector ──────────────────────────────────────────────── */}
          <div className="inspector">
            <div className="card card-padded">
              <div className="stat">
                <div className="label">Running total</div>
                <div className="value">{fmtMoney(grandTotal)}</div>
                <div className="sub">
                  {pricedSelected.length + validAdditional.length} lines · ex VAT
                </div>
              </div>
              {(pricedTotal > 0 || additionalTotal > 0) && (
                <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--line)", display: "grid", gap: 6 }}>
                  <Split label="Priced" value={fmtMoney(pricedTotal)} />
                  {additionalTotal > 0 && <Split label="Additional" value={fmtMoney(additionalTotal)} accent />}
                </div>
              )}
            </div>

            {budget.priced > 0 && (
              <div className="card card-padded">
                <div className="eyebrow">Budget · {project.project.code}</div>
                <div className="bar" style={{ marginTop: 10 }}>
                  <div style={{ width: `${Math.min(100, (budget.committed / budget.priced) * 100)}%` }} />
                </div>
                <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>Now · {((budget.committed / budget.priced) * 100).toFixed(0)}% committed</div>
                <div className="bar" style={{ marginTop: 10 }}>
                  <div className="accent" style={{ width: `${Math.min(100, (projectedCommitted / budget.priced) * 100)}%` }} />
                </div>
                <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                  If submitted · {((projectedCommitted / budget.priced) * 100).toFixed(0)}% · {fmtMoney(Math.max(0, budget.priced - projectedCommitted))} left
                </div>
                {hasAdditional && (
                  <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                    + {fmtMoney(additionalTotal)} in unpriced items (outside the BOQ)
                  </div>
                )}
              </div>
            )}

            <div className="card card-padded">
              <div className="eyebrow">Approval</div>
              {needsApproval ? (
                <>
                  <div style={{ marginTop: 8, fontSize: 14, fontWeight: 500 }}>
                    Goes to <b>{tierPreview}</b>
                  </div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                    {hasAdditional && hasOver
                      ? "Unpriced items + over allowance"
                      : hasAdditional
                        ? "Contains items outside the BOQ"
                        : "Exceeds priced allowance"}
                  </div>
                </>
              ) : (
                <>
                  <div style={{ marginTop: 8, fontSize: 14, fontWeight: 500 }}>Auto-approved</div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>All lines priced and within allowance</div>
                </>
              )}
            </div>
          </div>
        </div>
      </form>
      </main>
    </>
  );
}

function Split({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
      <span className="muted">{label}</span>
      <span className="num" style={accent ? { color: "var(--accent-2)" } : undefined}>{value}</span>
    </div>
  );
}

function AdditionalRowEditor({
  row, idx, libraryTypes, library, onChange, onPick, onRemove,
}: {
  row: AdditionalRow;
  idx: number;
  libraryTypes: string[];
  library: MaterialWithCommitment[];
  onChange: (p: Partial<AdditionalRow>) => void;
  onPick: (materialIdStr: string) => void;
  onRemove: () => void;
}) {
  const itemsInType = useMemo(
    () => library.filter((m) => !row.type || m.type === row.type),
    [library, row.type],
  );
  const autoFilled = row.source === "library" && row.material_id != null;

  return (
    <div
      style={{
        borderTop: idx === 0 ? "none" : "1px solid var(--line)",
        paddingTop: idx === 0 ? 0 : 20,
        marginTop: idx === 0 ? 0 : 20,
      }}
    >
      <div className="add-row">
        {/* Row 1: Type · Item · Manufacturer */}
        <div className="add-row-top">
          <div>
            <label>Type</label>
            <select
              value={row.type}
              onChange={(e) =>
                onChange({
                  type: e.target.value,
                  material_id: null,
                  item: row.source === "library" ? "" : row.item,
                })
              }
              disabled={row.source === "custom"}
            >
              <option value="">— select —</option>
              {libraryTypes.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label>Item</label>
            {row.source === "custom" ? (
              <input
                value={row.item}
                onChange={(e) => onChange({ item: e.target.value })}
                placeholder="Custom item description"
              />
            ) : (
              <select
                value={row.material_id ?? ""}
                onChange={(e) => onPick(e.target.value)}
                disabled={!row.type}
              >
                <option value="">{row.type ? "— select item —" : "Choose type first"}</option>
                {itemsInType.map((m) => (
                  <option key={m.id} value={m.id}>{m.item}</option>
                ))}
                <option value="__custom__">+ Custom item (not in database)…</option>
              </select>
            )}
          </div>
          <div>
            <label>Manufacturer</label>
            <input
              value={row.manufacturer}
              onChange={(e) => onChange({ manufacturer: e.target.value })}
              placeholder={autoFilled ? "" : "—"}
              readOnly={autoFilled}
            />
          </div>
        </div>

        {/* Row 2: Qty · Unit · Unit cost · Line total · Remove */}
        <div className="add-row-bottom">
          <div>
            <label>Qty</label>
            <input
              type="number"
              step="any"
              className="num"
              value={row.qty || ""}
              onChange={(e) => onChange({ qty: Number(e.target.value) })}
            />
          </div>
          <div>
            <label>Unit</label>
            <input
              value={row.unit}
              onChange={(e) => onChange({ unit: e.target.value })}
              placeholder="ea"
              readOnly={autoFilled}
            />
          </div>
          <div>
            <label>Unit cost (£)</label>
            <input
              type="number"
              step="0.01"
              className="num"
              value={row.unit_cost || ""}
              onChange={(e) => onChange({ unit_cost: Number(e.target.value) })}
              readOnly={autoFilled}
            />
          </div>
          <div>
            <label>Line total</label>
            <div className="line-total">{fmtMoney(row.qty * row.unit_cost)}</div>
          </div>
          <button
            type="button"
            className="ghost remove-btn"
            onClick={onRemove}
            title="Remove"
            aria-label="Remove item"
          >
            ×
          </button>
        </div>
      </div>
      <div style={{ marginTop: 6 }}>
        <span className="badge unpriced">unpriced</span>{" "}
        <span className="muted">
          {row.source === "library"
            ? "Item is in the materials library but wasn’t priced for this job — needs approval."
            : "Custom item — needs approval."}
        </span>
      </div>
    </div>
  );
}
