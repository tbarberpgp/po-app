import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, fmtMoney } from "../lib/api";
import { Topbar } from "./Shell";
import { SupplierCombobox, compareSuppliers } from "./SupplierCombobox";
import type { Supplier } from "../../shared/types";

const todayISO = () => new Date().toISOString().slice(0, 10);
function addWeeksISO(iso: string, weeks: number): string {
  const d = new Date(iso + "T00:00:00Z");
  if (isNaN(d.getTime())) return "";
  d.setUTCDate(d.getUTCDate() + Math.round(weeks * 7));
  return d.toISOString().slice(0, 10);
}
const fmtDate = (iso: string) => (iso ? new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "");

/** Raise a plant-hire PO from the PO area. Mirrors the project Plant tab's
 *  "Add plant" flow: creates a Preliminaries PO (rate × weeks) and a linked
 *  plant log so it appears on the Plant tab and gets off-hire reminders. */
export function NewPlantPO() {
  const { id: projectId = "" } = useParams();
  const nav = useNavigate();
  const [project, setProject] = useState<{ code: string; name: string } | null>(null);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplier, setSupplier] = useState("");
  const [supplierCustom, setSupplierCustom] = useState(false);
  const [item, setItem] = useState("");
  const [onHireFrom, setOnHireFrom] = useState(todayISO());
  const [dayRate, setDayRate] = useState("");
  const [rateUnit, setRateUnit] = useState<"day" | "week">("week");
  const [expectedWeeks, setExpectedWeeks] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) return;
    api.getProject(projectId).then((p) => setProject({ code: p.project.code, name: p.project.name })).catch(() => {});
    api.listSuppliers().then(setSuppliers).catch(() => setSuppliers([]));
  }, [projectId]);
  const supplierOpts = useMemo(
    () => suppliers.map((s) => ({ name: s.name, status: s.status, priced: 0, total: 0 })).sort(compareSuppliers),
    [suppliers],
  );

  const rateNum = Number(dayRate) || 0;
  const weeksNum = Number(expectedWeeks) || 0;
  const weeklyRate = rateUnit === "week" ? rateNum : rateNum * 7;
  const poEstimate = weeklyRate * weeksNum;
  const valid = !!item.trim() && !!supplier.trim() && rateNum > 0 && weeksNum > 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!projectId) return;
    if (!item.trim()) return setErr("Name the plant item.");
    if (!supplier.trim()) return setErr("Pick a supplier.");
    if (rateNum <= 0) return setErr("Enter the hire rate.");
    if (weeksNum <= 0) return setErr("Enter the expected hire duration in weeks.");
    setBusy(true); setErr(null);
    try {
      const po = await api.createPO({
        project_id: projectId,
        supplier: supplier.trim(),
        category: "prelims",
        notes: `Plant hire — ${item.trim()} · ${weeksNum} wk${weeksNum === 1 ? "" : "s"} @ £${rateNum}/${rateUnit}`,
        lines: [{ material_id: null, item: `Plant hire — ${item.trim()}`, type: "Plant hire", qty: weeksNum, unit: "week", unit_cost: weeklyRate }],
      });
      await api.opsAddPlant(projectId, {
        item: item.trim(), supplier: supplier.trim(), on_hire_from: onHireFrom || undefined,
        day_rate: rateNum, rate_unit: rateUnit, expected_weeks: weeksNum, po_id: po.id,
        notes: notes.trim() || undefined,
      });
      nav(`/pos/${po.id}`);
    } catch (e) { setErr(e instanceof Error ? e.message : "failed"); setBusy(false); }
  }

  return (
    <>
      <Topbar
        crumbs={<><Link to="/pos">Purchase Orders</Link>{project && <> / <Link to={`/projects/${projectId}`}>{project.code}</Link></>} / Plant hire</>}
        title="New plant hire PO"
        actions={
          <>
            <Link to={projectId ? `/projects/${projectId}` : "/pos"} className="btn ghost">Cancel</Link>
            <button type="submit" form="new-plant-po-form" className="accent" disabled={busy || !valid}>{busy ? "Raising PO…" : "Raise plant PO"}</button>
          </>
        }
      />
      <main>
        <form id="new-plant-po-form" onSubmit={submit}>
          {err && <div className="flash error">{err}</div>}
          <div className="card card-padded" style={{ maxWidth: 640 }}>
            <div className="ck-short" style={{ marginBottom: 14 }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-2)" strokeWidth="1.8"><path d="M12 16V4M8 8l4-4 4 4M5 20h14" /></svg>
              <span>Plant hire raises a <b>Preliminaries</b> PO and records the item on the project's Plant tab for off-hire reminders.</span>
            </div>
            <div className="ops-form-grid">
              <label className="field" style={{ gridColumn: "1 / -1" }}><span>Item *</span>
                <input className="input" value={item} onChange={(e) => setItem(e.target.value)} placeholder="e.g. Genie GS-1932 scissor lift" autoFocus />
              </label>
              <label className="field"><span>Supplier *</span>
                {supplierCustom ? (
                  <div className="row" style={{ gap: 6 }}>
                    <input className="input" value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="Type supplier name" style={{ flex: 1, minWidth: 0 }} autoFocus />
                    <button type="button" className="ghost tiny" onClick={() => { setSupplierCustom(false); setSupplier(""); }}>From list</button>
                  </div>
                ) : (
                  <SupplierCombobox onProject={[]} offProject={supplierOpts} value={supplier} isCustom={false}
                    onChange={setSupplier} onCustom={() => { setSupplierCustom(true); setSupplier(""); }} />
                )}
              </label>
              <label className="field"><span>On hire from</span><input className="input" type="date" value={onHireFrom} onChange={(e) => setOnHireFrom(e.target.value)} /></label>
              <label className="field"><span>Rate (£)</span>
                <div className="row" style={{ gap: 6 }}>
                  <input className="input" type="number" inputMode="decimal" min="0" value={dayRate} onChange={(e) => setDayRate(e.target.value)} style={{ flex: 1, minWidth: 0 }} />
                  <select className="input" value={rateUnit} onChange={(e) => setRateUnit(e.target.value as "day" | "week")} style={{ width: "auto" }}>
                    <option value="day">/ day</option>
                    <option value="week">/ week</option>
                  </select>
                </div>
              </label>
              <label className="field"><span>Expected hire (weeks)</span><input className="input" type="number" inputMode="decimal" min="0" step="0.5" value={expectedWeeks} onChange={(e) => setExpectedWeeks(e.target.value)} placeholder="e.g. 4" /></label>
              <label className="field" style={{ gridColumn: "1 / -1" }}><span>Notes</span><input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
            </div>
            <div className="muted" style={{ fontSize: 13, marginTop: 12 }}>
              {poEstimate > 0
                ? <>PO value ≈ <b>{fmtMoney(poEstimate)}</b> ({weeksNum} wk × {fmtMoney(weeklyRate)}/wk){onHireFrom && weeksNum > 0 ? <> · off-hire ≈ <b>{fmtDate(addWeeksISO(onHireFrom, weeksNum))}</b></> : null}</>
                : "Enter a rate and duration to see the PO value."}
            </div>
          </div>
        </form>
      </main>
    </>
  );
}
