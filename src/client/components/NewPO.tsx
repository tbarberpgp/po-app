import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, fmtMoney } from "../lib/api";
import type { MaterialWithCommitment } from "../../shared/types";

type Line = {
  key: string;
  type: string;        // selected type (top of cascade)
  material_id: number | null;
  item: string;
  manufacturer: string | null;
  qty: number;
  unit: string;
  unit_cost: number;
  unpriced_mode: boolean;
};

const newLine = (): Line => ({
  key: crypto.randomUUID(),
  type: "",
  material_id: null,
  item: "",
  manufacturer: null,
  qty: 0,
  unit: "",
  unit_cost: 0,
  unpriced_mode: false,
});

export function NewPO() {
  const { id: projectId } = useParams<{ id: string }>();
  const nav = useNavigate();
  const [project, setProject] = useState<Awaited<ReturnType<typeof api.getProject>> | null>(null);
  const [mats, setMats] = useState<MaterialWithCommitment[]>([]);
  const [supplier, setSupplier] = useState("");
  const [notes, setNotes] = useState("");
  const [deliveryDate, setDeliveryDate] = useState("");
  const [lines, setLines] = useState<Line[]>([newLine()]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) return;
    api.getProject(projectId).then(setProject).catch((e) => setErr(e.message));
    api.listMaterials(projectId).then(setMats).catch((e) => setErr(e.message));
  }, [projectId]);

  const typesInTab = useMemo(() => [...new Set(mats.map((m) => m.type))].sort(), [mats]);

  function update(key: string, patch: Partial<Line>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }
  function removeLine(key: string) {
    setLines((ls) => (ls.length > 1 ? ls.filter((l) => l.key !== key) : ls));
  }
  function addLine() {
    setLines((ls) => [...ls, newLine()]);
  }

  // For a given line, compute the over-budget hint based on current qty
  function budgetState(line: Line) {
    if (line.material_id == null) return { unpriced: line.unpriced_mode || line.material_id == null, over: false, msg: "" };
    const m = mats.find((mm) => mm.id === line.material_id);
    if (!m) return { unpriced: false, over: false, msg: "" };
    if (m.total_qty == null || m.total_qty === 0) {
      return { unpriced: true, over: false, msg: "Not priced for this job — will need approval." };
    }
    const remaining = (m.total_qty ?? 0) - (m.committed_qty ?? 0);
    if (line.qty > remaining) {
      const overBy = (line.qty - remaining).toLocaleString();
      return {
        unpriced: false,
        over: true,
        msg: `Over budget by ${overBy} ${m.total_qty_unit ?? ""} — will need approval.`,
      };
    }
    return { unpriced: false, over: false, msg: "" };
  }

  const total = lines.reduce((s, l) => s + l.qty * l.unit_cost, 0);
  const hasUnpriced = lines.some((l) => budgetState(l).unpriced);
  const hasOver = lines.some((l) => budgetState(l).over);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!projectId) return;
    if (!supplier.trim()) return setErr("Supplier is required");
    const cleanLines = lines.filter((l) => l.item.trim() && l.qty > 0);
    if (cleanLines.length === 0) return setErr("At least one line with qty > 0 is required");

    setBusy(true);
    setErr(null);
    try {
      const res = await api.createPO({
        project_id: projectId,
        supplier: supplier.trim(),
        notes: notes.trim() || undefined,
        delivery_date: deliveryDate || undefined,
        lines: cleanLines.map((l) => ({
          material_id: l.unpriced_mode ? null : l.material_id,
          item: l.item.trim(),
          type: l.type || null,
          manufacturer: l.manufacturer,
          qty: l.qty,
          unit: l.unit,
          unit_cost: l.unit_cost,
        })),
      });
      nav(`/pos/${res.id}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  if (!project) return <div className="muted">Loading…</div>;

  return (
    <>
      <div className="row" style={{ marginBottom: 16 }}>
        <h2 className="grow">Raise PO — {project.project.code}</h2>
        <Link to={`/projects/${projectId}`} className="btn secondary">Cancel</Link>
      </div>

      {err && <div className="flash error">{err}</div>}
      {(hasUnpriced || hasOver) && (
        <div className="flash info">
          This PO will be sent for approval ({hasUnpriced && hasOver ? "unpriced + over budget" : hasUnpriced ? "unpriced materials" : "over priced allowance"}).
        </div>
      )}

      <form onSubmit={submit}>
        <div className="card">
          <div className="row">
            <div className="grow">
              <label>Supplier</label>
              <input value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="e.g. Alumasc Roofing" required />
            </div>
            <div>
              <label>Delivery date</label>
              <input type="date" value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)} />
            </div>
          </div>
          <div style={{ marginTop: 12 }}>
            <label>Notes</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} style={{ width: "100%" }} />
          </div>
        </div>

        <div className="card">
          <div className="row" style={{ marginBottom: 12 }}>
            <h3 style={{ margin: 0 }} className="grow">Lines</h3>
            <button type="button" className="secondary" onClick={addLine}>+ Add line</button>
          </div>
          {lines.map((line, idx) => (
            <LineRow
              key={line.key}
              line={line}
              idx={idx}
              types={typesInTab}
              mats={mats}
              budget={budgetState(line)}
              onChange={(patch) => update(line.key, patch)}
              onRemove={() => removeLine(line.key)}
              canRemove={lines.length > 1}
            />
          ))}
        </div>

        <div className="card">
          <div className="row">
            <div className="grow" />
            <div style={{ textAlign: "right" }}>
              <div className="muted">Total</div>
              <div style={{ fontSize: 22, fontWeight: 600 }}>{fmtMoney(total)}</div>
            </div>
          </div>
        </div>

        <div className="row">
          <button type="submit" disabled={busy}>
            {busy ? "Submitting…" : (hasUnpriced || hasOver) ? "Submit for approval" : "Create PO"}
          </button>
        </div>
      </form>
    </>
  );
}

function LineRow({
  line, idx, types, mats, budget, onChange, onRemove, canRemove,
}: {
  line: Line;
  idx: number;
  types: string[];
  mats: MaterialWithCommitment[];
  budget: { unpriced: boolean; over: boolean; msg: string };
  onChange: (p: Partial<Line>) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const itemsInType = useMemo(
    () => mats.filter((m) => !line.type || m.type === line.type),
    [mats, line.type],
  );
  const selected = line.material_id ? mats.find((m) => m.id === line.material_id) : null;

  function pickMaterial(idStr: string) {
    if (idStr === "__custom__") {
      onChange({
        material_id: null,
        unpriced_mode: true,
        item: "",
        manufacturer: null,
        unit: "",
        unit_cost: 0,
      });
      return;
    }
    const m = mats.find((mm) => String(mm.id) === idStr);
    if (!m) return;
    onChange({
      material_id: m.id,
      unpriced_mode: false,
      item: m.item,
      manufacturer: m.manufacturer,
      unit: m.total_qty_unit ?? m.rate_unit ?? m.coverage_unit ?? "",
      unit_cost: m.unit_rate ?? 0,
    });
  }

  return (
    <div style={{ borderTop: idx === 0 ? "none" : "1px solid var(--border)", paddingTop: idx === 0 ? 0 : 16, marginTop: idx === 0 ? 0 : 16 }}>
      <div className="row" style={{ alignItems: "flex-end" }}>
        <div style={{ width: 160 }}>
          <label>Type</label>
          <select
            value={line.type}
            onChange={(e) => onChange({ type: e.target.value, material_id: null, item: "", manufacturer: null, unpriced_mode: false })}
          >
            <option value="">— select —</option>
            {types.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div className="grow">
          <label>Item</label>
          {line.unpriced_mode ? (
            <input value={line.item} onChange={(e) => onChange({ item: e.target.value })} placeholder="Custom / not priced item" />
          ) : (
            <select
              value={line.material_id ?? ""}
              onChange={(e) => pickMaterial(e.target.value)}
              disabled={!line.type}
            >
              <option value="">{line.type ? "— select item —" : "Choose type first"}</option>
              {itemsInType.map((m) => (
                <option key={m.id} value={m.id}>{m.item}</option>
              ))}
              <option value="__custom__">+ Add unpriced item…</option>
            </select>
          )}
        </div>
        <div style={{ width: 140 }}>
          <label>Manufacturer</label>
          <input
            value={line.manufacturer ?? ""}
            onChange={(e) => onChange({ manufacturer: e.target.value })}
            placeholder="—"
            readOnly={!line.unpriced_mode && !!selected?.manufacturer}
            style={!line.unpriced_mode && !!selected?.manufacturer ? { background: "var(--header-bg)" } : undefined}
          />
        </div>
        <div style={{ width: 100 }}>
          <label>Qty</label>
          <input type="number" step="any" value={line.qty || ""} onChange={(e) => onChange({ qty: Number(e.target.value) })} />
        </div>
        <div style={{ width: 80 }}>
          <label>Unit</label>
          <input value={line.unit} onChange={(e) => onChange({ unit: e.target.value })} placeholder="ea" />
        </div>
        <div style={{ width: 110 }}>
          <label>Unit cost (£)</label>
          <input type="number" step="0.01" value={line.unit_cost || ""} onChange={(e) => onChange({ unit_cost: Number(e.target.value) })} />
        </div>
        <div style={{ width: 110, textAlign: "right" }}>
          <label>Line total</label>
          <div style={{ padding: "8px 0" }}>{fmtMoney(line.qty * line.unit_cost)}</div>
        </div>
        {canRemove && (
          <button type="button" className="secondary" onClick={onRemove} title="Remove line">×</button>
        )}
      </div>
      {(budget.over || budget.unpriced) && (
        <div style={{ marginTop: 6 }}>
          <span className={"badge " + (budget.unpriced ? "unpriced" : "over")}>
            {budget.unpriced ? "Unpriced" : "Over budget"}
          </span>{" "}
          <span className="muted">{budget.msg}</span>
        </div>
      )}
      {selected && !budget.unpriced && !budget.over && selected.total_qty != null && (
        <div style={{ marginTop: 6 }}>
          <span className="muted">
            Remaining allowance: {(selected.total_qty - (selected.committed_qty ?? 0) - line.qty).toLocaleString()} {selected.total_qty_unit ?? ""}
          </span>
        </div>
      )}
    </div>
  );
}
