import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, fmtMoney } from "../lib/api";
import { Topbar } from "./Shell";
import type { MaterialWithCommitment } from "../../shared/types";

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
  }, [projectId]);

  // Suppliers shown in the dropdown = distinct manufacturers across the snapshot.
  // (Including suppliers with no priced items for this job, so PMs can still raise
  // an "additional items only" PO if needed.)
  const suppliers = useMemo(() => {
    const set = new Map<string, { priced: number; total: number }>();
    for (const m of mats) {
      const key = m.manufacturer?.trim() || NO_MFR;
      const cur = set.get(key) ?? { priced: 0, total: 0 };
      cur.total += 1;
      if (isPriced(m)) cur.priced += 1;
      set.set(key, cur);
    }
    return [...set.entries()]
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.priced - a.priced || a.name.localeCompare(b.name));
  }, [mats]);

  const isCustomSupplier = supplier === "__other__";
  const effectiveSupplier = isCustomSupplier
    ? customSupplier.trim()
    : supplier === NO_MFR
      ? ""
      : supplier;

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

  if (!project) return <main className="muted">Loading…</main>;

  return (
    <>
      <Topbar
        crumbs={<><Link to="/">Projects</Link> / <Link to={`/projects/${projectId}`}>{project.project.code}</Link> / New PO</>}
        title="New Purchase Order"
        actions={<Link to={`/projects/${projectId}`} className="btn ghost">Cancel</Link>}
      />
      <main>
      {err && <div className="flash error">{err}</div>}

      <form onSubmit={submit}>
        {/* Supplier selection */}
        <div className="card">
          <div className="row">
            <div style={{ minWidth: 280 }}>
              <label>Supplier</label>
              <select value={supplier} onChange={(e) => setSupplier(e.target.value)}>
                <option value="">— select supplier —</option>
                {suppliers.map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.name} — {s.priced} priced{s.priced !== s.total ? `, ${s.total - s.priced} in library` : ""}
                  </option>
                ))}
                <option value="__other__">+ Other supplier (custom)…</option>
              </select>
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
            <div className="row" style={{ marginBottom: 12 }}>
              <h3 style={{ margin: 0 }} className="grow">
                Priced items <span className="muted" style={{ fontWeight: 400 }}>from {supplier}</span>
              </h3>
              <input placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 220 }} />
              <span className="muted">{pricedSelected.length} selected · {fmtMoney(pricedTotal)}</span>
            </div>
            {pricedForSupplier.length === 0 ? (
              <div className="muted">
                No items priced for this job from {supplier}. Use the “Additional items” section below.
              </div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 36 }}></th>
                    <th>Item</th>
                    <th>Type</th>
                    <th className="num">Pack cost</th>
                    <th>Unit</th>
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
                      <tr key={m.id} style={row ? { background: "var(--row-hover)" } : undefined}>
                        <td><input type="checkbox" checked={!!row} onChange={() => toggleRow(m)} /></td>
                        <td>{m.item}</td>
                        <td>{m.type}</td>
                        <td className="num">{m.cost != null ? fmtMoney(m.cost) : <span className="muted">—</span>}</td>
                        <td>{unit}</td>
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
            <div className="row" style={{ marginBottom: 12 }}>
              <div className="grow">
                <h3 style={{ margin: 0 }}>Additional items</h3>
                <div className="muted">Anything not priced in the BOQ for this job — picked from the materials library, or custom.</div>
              </div>
              <button type="button" className="secondary" onClick={addAdditional}>+ Add item</button>
            </div>

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
        )}

        {/* Footer */}
        {(supplier || isCustomSupplier) && (
          <>
            {needsApproval && (
              <div className="flash info">
                This PO will be sent for approval (
                {hasAdditional && hasOver
                  ? "additional/unpriced items + over priced allowance"
                  : hasAdditional
                    ? "contains items outside the priced BOQ"
                    : "exceeds priced allowance"}
                ).
              </div>
            )}
            <div className="card">
              <div className="row">
                <div className="grow">
                  <div className="muted">
                    Priced: {fmtMoney(pricedTotal)} · Additional: {fmtMoney(additionalTotal)}
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div className="muted">Total</div>
                  <div style={{ fontSize: 22, fontWeight: 600 }}>{fmtMoney(grandTotal)}</div>
                </div>
              </div>
            </div>
            <div className="row">
              <button type="submit" className="accent" disabled={busy || grandTotal <= 0}>
                {busy ? "Submitting…" : needsApproval ? "Submit for approval" : "Create PO"}
              </button>
            </div>
          </>
        )}
      </form>
      </main>
    </>
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
    <div style={{ borderTop: idx === 0 ? "none" : "1px solid var(--border)", paddingTop: idx === 0 ? 0 : 16, marginTop: idx === 0 ? 0 : 16 }}>
      <div className="row" style={{ alignItems: "flex-end" }}>
        <div style={{ width: 150 }}>
          <label>Type</label>
          <select
            value={row.type}
            onChange={(e) => onChange({ type: e.target.value, material_id: null, item: row.source === "library" ? "" : row.item })}
            disabled={row.source === "custom"}
          >
            <option value="">— select —</option>
            {libraryTypes.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div className="grow">
          <label>Item</label>
          {row.source === "custom" ? (
            <input value={row.item} onChange={(e) => onChange({ item: e.target.value })} placeholder="Custom item description" />
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
        <div style={{ width: 140 }}>
          <label>Manufacturer</label>
          <input
            value={row.manufacturer}
            onChange={(e) => onChange({ manufacturer: e.target.value })}
            placeholder="—"
            readOnly={autoFilled}
            style={autoFilled ? { background: "var(--header-bg)" } : undefined}
          />
        </div>
        <div style={{ width: 100 }}>
          <label>Qty</label>
          <input type="number" step="any" value={row.qty || ""} onChange={(e) => onChange({ qty: Number(e.target.value) })} />
        </div>
        <div style={{ width: 80 }}>
          <label>Unit</label>
          <input
            value={row.unit}
            onChange={(e) => onChange({ unit: e.target.value })}
            placeholder="ea"
            readOnly={autoFilled}
            style={autoFilled ? { background: "var(--header-bg)" } : undefined}
          />
        </div>
        <div style={{ width: 110 }}>
          <label>Unit cost (£)</label>
          <input
            type="number" step="0.01"
            value={row.unit_cost || ""}
            onChange={(e) => onChange({ unit_cost: Number(e.target.value) })}
            readOnly={autoFilled}
            style={autoFilled ? { background: "var(--header-bg)" } : undefined}
          />
        </div>
        <div style={{ width: 110, textAlign: "right" }}>
          <label>Line total</label>
          <div style={{ padding: "8px 0" }}>{fmtMoney(row.qty * row.unit_cost)}</div>
        </div>
        <button type="button" className="secondary" onClick={onRemove} title="Remove">×</button>
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
