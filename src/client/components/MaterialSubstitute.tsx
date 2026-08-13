// Material substitution UI — the badge, the per-row action (Substitute / Edit /
// revert) and the freeform-or-library modal. Shared so the same swap flow works
// from the project Materials tab, the grouped-site Materials tab and the PO area
// (New PO). A FULL swap retargets the line's supplier/cost immediately; a PART
// swap diverts only some of the quantity and goes for approval first.

import { useEffect, useState } from "react";
import { api, fmtMoney, fmtQty } from "../lib/api";
import type { MaterialWithCommitment } from "../../shared/types";

export function SubBadge({ kind, reason, by, at, part }: {
  kind?: string | null;
  reason?: string | null;
  by?: string | null;
  at?: string | null;
  /** When set, this is a PART substitution — show the substituted quantity. */
  part?: { qty: number; total: number; unit: string };
}) {
  const label = part ? "Part-subbed" : kind === "variation" ? "Variation" : kind === "equivalent_spec" ? "Equiv. spec" : "Subbed";
  const tone = kind === "variation" ? "pending" : kind === "equivalent_spec" ? "issued" : "approved";
  return (
    <span
      className={`pill ${tone}`}
      style={{ fontSize: 10, marginTop: 4, display: "inline-flex" }}
      title={[part ? `${part.qty} of ${part.total} ${part.unit} substituted` : null, reason, by ? `by ${by}` : null, at ? `on ${at.slice(0, 10)}` : null].filter(Boolean).join(" · ") || undefined}
    >
      {part ? `Part-subbed (${fmtQty(part.qty)} ${part.unit})` : label}
    </span>
  );
}

export function SubstituteAction({ material, onChanged }: { material: MaterialWithCommitment; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const isSubbed = !!material.sub_id;

  async function revert() {
    if (!material.sub_id) return;
    const reason = prompt("Reason for reverting (optional)") ?? undefined;
    await api.revertSubstitution(material.sub_id, reason);
    onChanged();
  }

  return (
    <>
      {isSubbed ? (
        <>
          <button className="ghost tiny" onClick={() => setOpen(true)} title="Change replacement">Edit</button>
          <button className="ghost tiny" onClick={revert} title="Revert to original material" style={{ marginLeft: 4 }}>↺</button>
        </>
      ) : (
        <button className="ghost tiny" onClick={() => setOpen(true)} title="Swap this material for a different supplier / brand / spec">Substitute</button>
      )}
      {open && (
        <SubstituteModal
          material={material}
          onCancel={() => setOpen(false)}
          onSaved={() => { setOpen(false); onChanged(); }}
        />
      )}
    </>
  );
}

export function SubstituteModal({
  material, onCancel, onSaved,
}: {
  material: MaterialWithCommitment;
  onCancel: () => void;
  onSaved: () => void;
}) {
  type Source = "library" | "freeform";
  const [source, setSource] = useState<Source>("freeform");
  const [kind, setKind] = useState<"like_for_like" | "equivalent_spec" | "variation">("like_for_like");

  // Library picker state
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<Awaited<ReturnType<typeof api.searchProductsForQuote>>>([]);
  const [productId, setProductId] = useState<number | null>(null);

  // Freeform fields (pre-filled from a picked product or the current sub).
  const [item, setItem] = useState(material.sub_item ?? "");
  const [manufacturer, setManufacturer] = useState(material.sub_manufacturer ?? "");
  const [supplier, setSupplier] = useState(material.sub_supplier ?? "");
  const [cost, setCost] = useState<string>(material.sub_cost != null ? String(material.sub_cost) : "");
  const [unit, setUnit] = useState(material.sub_unit ?? material.total_units_unit ?? material.pack_unit ?? "");
  const [reason, setReason] = useState(material.sub_reason ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  // Part substitution: how much of the BOQ quantity to divert (blank = whole lot).
  const [partQty, setPartQty] = useState<string>("");
  const totalUnits = material.total_units ?? null;
  const partNum = partQty.trim() === "" ? null : Number(partQty);
  const isPart = partNum != null && Number.isFinite(partNum) && partNum > 0 && totalUnits != null && partNum < totalUnits;
  const remainder = isPart && totalUnits != null ? totalUnits - (partNum as number) : null;
  const qtyUnit = material.total_units_unit ?? material.pack_unit ?? "";

  // Approved-supplier names back the Manufacturer / Supplier pickers so swaps
  // stay on the known register (typing is still allowed for a one-off).
  const [supplierNames, setSupplierNames] = useState<string[]>([]);
  useEffect(() => {
    api.listSuppliers()
      .then((rows) => setSupplierNames([...new Set(rows.map((s) => s.name).filter(Boolean))].sort((a, b) => a.localeCompare(b))))
      .catch(() => setSupplierNames([]));
  }, []);
  const mfrListId = `sub-suppliers-${material.id}`;

  useEffect(() => {
    if (source !== "library") return;
    if (search.trim().length < 2) { setHits([]); return; }
    const t = setTimeout(() => {
      api.searchProductsForQuote(search).then(setHits).catch(() => setHits([]));
    }, 200);
    return () => clearTimeout(t);
  }, [source, search]);

  function pickHit(h: Awaited<ReturnType<typeof api.searchProductsForQuote>>[number]) {
    setProductId(h.id);
    setItem(h.description);
    setManufacturer(h.manufacturer ?? "");
    setCost(h.unit_cost != null ? String(h.unit_cost) : "");
    setUnit(h.unit ?? unit);
  }

  async function save() {
    if (!item.trim()) { setErr("Replacement item description is required"); return; }
    setBusy(true); setErr(null);
    try {
      const res = await api.substituteMaterial(material.id, {
        kind,
        reason: reason.trim() || null,
        product_id: source === "library" ? productId : null,
        replacement_item: item.trim(),
        replacement_manufacturer: manufacturer.trim() || null,
        replacement_supplier: supplier.trim() || null,
        replacement_cost: cost === "" ? null : Number(cost),
        replacement_unit: unit.trim() || null,
        sub_units: isPart ? (partNum as number) : null,
      });
      if (res.pending) { setSubmitted(true); setBusy(false); return; }
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "save failed");
    } finally { setBusy(false); }
  }

  if (submitted) {
    return (
      <div style={{ position: "fixed", inset: 0, background: "rgba(15,17,48,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }} onClick={onSaved}>
        <div className="card" style={{ maxWidth: 440, width: "calc(100% - 32px)" }} onClick={(e) => e.stopPropagation()}>
          <div className="card-hd"><h3 style={{ flex: 1 }}>Sent for approval</h3></div>
          <div className="card-bd">
            <div className="flash success" style={{ marginBottom: 12 }}>
              Part-substitution submitted. It’ll take effect once an approver signs it off — until then the original stays in place.
            </div>
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button className="accent" onClick={onSaved}>Done</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(15,17,48,0.45)",
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100,
      }}
      onClick={onCancel}
    >
      <div
        className="card"
        style={{ maxWidth: 640, width: "calc(100% - 32px)", maxHeight: "calc(100vh - 64px)", overflow: "auto" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="card-hd"><h3 style={{ flex: 1 }}>{material.sub_id ? "Edit substitution" : "Substitute material"}</h3></div>
        <div className="card-bd">
          {err && <div className="flash error" style={{ marginBottom: 8 }}>{err}</div>}

          <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
            Original: <b>{material.item}</b>{material.manufacturer ? <> · {material.manufacturer}</> : null}
            {material.cost != null && <> · {fmtMoney(material.cost)}</>}
          </div>

          <div className="eyebrow">Source</div>
          <div style={{ display: "flex", gap: 6, marginTop: 6, marginBottom: 12 }}>
            <button type="button" className={source === "freeform" ? "primary tiny" : "ghost tiny"} onClick={() => setSource("freeform")}>Freeform</button>
            <button type="button" className={source === "library" ? "primary tiny" : "ghost tiny"} onClick={() => setSource("library")}>Product library</button>
          </div>

          {source === "library" && (
            <div style={{ marginBottom: 12 }}>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search products by description / manufacturer…"
                style={{ width: "100%" }}
              />
              {hits.length > 0 && (
                <div style={{ marginTop: 6, maxHeight: 180, overflowY: "auto", border: "1px solid var(--line)", borderRadius: "var(--radius-md)" }}>
                  {hits.map((h) => (
                    <div
                      key={h.id}
                      onClick={() => pickHit(h)}
                      style={{
                        padding: "8px 10px", cursor: "pointer", fontSize: 13,
                        background: productId === h.id ? "var(--accent-soft)" : "transparent",
                        borderBottom: "1px solid var(--line)",
                      }}
                    >
                      <div>
                        <span className="badge" style={{ fontFamily: "ui-monospace, monospace", marginRight: 6 }}>{h.product_code}</span>
                        {h.description}
                      </div>
                      <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                        {h.manufacturer ?? "—"} · {h.unit ?? "—"} · {h.unit_cost != null ? fmtMoney(h.unit_cost) : "no price"}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div style={{ display: "grid", gap: 8 }}>
            <div>
              <label>Replacement item</label>
              <input value={item} onChange={(e) => setItem(e.target.value)} placeholder="e.g. Recticel Eurothane GP 100mm PIR" />
            </div>
            <div className="row" style={{ gap: 8 }}>
              <div style={{ flex: 1 }}>
                <label>Manufacturer</label>
                <input value={manufacturer} onChange={(e) => setManufacturer(e.target.value)} list={mfrListId} placeholder="Pick or type a manufacturer" />
              </div>
              <div style={{ flex: 1 }}>
                <label>Supplier</label>
                <input value={supplier} onChange={(e) => setSupplier(e.target.value)} list={mfrListId} placeholder="defaults to manufacturer" />
              </div>
              <datalist id={mfrListId}>
                {supplierNames.map((n) => <option key={n} value={n} />)}
              </datalist>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <div style={{ flex: 1 }}>
                <label>Unit cost (£)</label>
                <input type="number" step="any" value={cost} onChange={(e) => setCost(e.target.value)} />
              </div>
              <div style={{ flex: 1 }}>
                <label>Unit</label>
                <input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="ea / m² / Roll" />
              </div>
            </div>
            <div>
              <label>Quantity to substitute</label>
              <div className="row" style={{ gap: 8, alignItems: "center" }}>
                <input type="number" step="any" min="0" value={partQty} onChange={(e) => setPartQty(e.target.value)}
                  placeholder={totalUnits != null ? `Whole lot (${totalUnits.toLocaleString("en-GB", { maximumFractionDigits: 2 })} ${qtyUnit})` : "Whole lot"}
                  style={{ flex: 1 }} />
                {qtyUnit && <span className="muted" style={{ fontSize: 12 }}>{qtyUnit}</span>}
              </div>
              {isPart ? (
                <div className="flash" style={{ background: "var(--warn-soft)", color: "var(--warn)", fontSize: 11.5, marginTop: 6, marginBottom: 0, padding: "7px 10px" }}>
                  Substituting <b>{(partNum as number).toLocaleString("en-GB", { maximumFractionDigits: 2 })} {qtyUnit}</b> — <b>{(remainder as number).toLocaleString("en-GB", { maximumFractionDigits: 2 })} {qtyUnit}</b> stays on the original. A part-substitution needs approval before it takes effect.
                </div>
              ) : (
                <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>Leave blank to swap the whole quantity.</div>
              )}
            </div>
            <div>
              <label>Kind</label>
              <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                <option value="like_for_like">Like-for-like (brand swap, same spec)</option>
                <option value="equivalent_spec">Equivalent spec (different unit / pack)</option>
                <option value="variation">Variation (materially different)</option>
              </select>
            </div>
            <div>
              <label>Reason (optional, audit trail)</label>
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Alumasc lead time too long" />
            </div>
          </div>

          <div className="muted" style={{ fontSize: 11, marginTop: 12 }}>
            Existing POs stay linked to the original material. Only new POs raised after this swap will default to the replacement. BOQ allowance continues to draw down against the original line.
          </div>
        </div>
        <div className="card-hd" style={{ borderTop: "1px solid var(--line)", borderBottom: "none" }}>
          <div style={{ flex: 1 }} />
          <button className="ghost" onClick={onCancel} disabled={busy}>Cancel</button>{" "}
          <button className="accent" onClick={save} disabled={busy || !item.trim()}>{busy ? "Saving…" : isPart ? "Send for approval" : material.sub_id ? "Save change" : "Save substitution"}</button>
        </div>
      </div>
    </div>
  );
}
