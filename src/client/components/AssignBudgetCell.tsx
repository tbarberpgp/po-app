import { useState } from "react";
import { api, fmtQty } from "../lib/api";
import { GroupedCombobox } from "./GroupedCombobox";
import type { MaterialWithCommitment } from "../../shared/types";

/**
 * Inline "assign this cost to a budget item" control for the Unexpected-spend
 * drill: an off-BOQ PO line picks a materials-budget line and its £ moves from
 * unexpected spend into that line's committed (same endpoint and alias
 * learning as the assign flow on the PO page). The row stays visible with a
 * ✓ until the drawer is next opened from fresh data.
 */
/** Width the assign column always reserves, open or closed — see below. */
const ASSIGN_W = 230;

export function AssignBudgetCell({ poId, lineId, mats, suggestId, suggestItem, onAssigned }: {
  poId: string;
  lineId: number;
  mats: MaterialWithCommitment[];
  /** The budget line this wording was coded to before, from the learned aliases.
   *  Offered as a one-click accept so the same decision isn't re-made by hand. */
  suggestId?: number;
  suggestItem?: string;
  onAssigned?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [doneLabel, setDoneLabel] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (doneLabel) {
    return <span style={{ fontSize: 12, color: "var(--success)", whiteSpace: "nowrap" }} title="Coded to the budget — it leaves Unexpected spend next time this opens">✓ {doneLabel}</span>;
  }
  // The closed state reserves the SAME width the open picker needs, so opening
  // it doesn't squeeze the Detail column and reflow the whole drawer.
  if (!open) {
    return (
      <div style={{ minWidth: ASSIGN_W, display: "flex", justifyContent: "flex-end", gap: 6, alignItems: "center" }}>
        {suggestId != null && suggestItem && (
          <button
            className="ghost tiny"
            style={{ whiteSpace: "nowrap", maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis" }}
            title={`Code it to “${suggestItem}”, where this wording was coded before. Click Assign to pick a different line.`}
            disabled={busy}
            onClick={() => void assign(String(suggestId))}
          >
            {busy ? "Coding…" : `↩ ${suggestItem}`}
          </button>
        )}
        <button className="ghost tiny" style={{ whiteSpace: "nowrap" }} title="Code this cost to a budget line so it counts inside the project budget" onClick={() => setOpen(true)}>Assign →</button>
        {err && <span style={{ fontSize: 11.5, color: "var(--danger)" }}>{err}</span>}
      </div>
    );
  }

  const byGroup = new Map<string, MaterialWithCommitment[]>();
  for (const m of mats) {
    const g = m.element_name || m.type || "Other";
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g)!.push(m);
  }
  const groups = [...byGroup.entries()].map(([label, ms]) => ({
    label,
    options: ms.map((m) => {
      // The decision aid here is headroom, not the element code (the group
      // header already says where you are): budgeted qty + how much is left.
      // Budget reads in the measured unit (m²/lm); remaining is tracked in
      // pack units (how POs are raised), so it carries its own unit label.
      const budget = m.total_qty != null
        ? (m.total_qty > 0 ? `${fmtQty(m.total_qty)}${m.rate_unit ? ` ${m.rate_unit}` : ""} budgeted` : "no budgeted qty")
        : null;
      const packUnit = m.total_units_unit ? ` ${m.total_units_unit}` : "";
      const left = m.remaining_qty != null
        ? (m.remaining_qty < 0 ? `${fmtQty(-m.remaining_qty)}${packUnit} over` : `${fmtQty(m.remaining_qty)}${packUnit} left`)
        : null;
      return {
        value: String(m.id),
        label: m.item?.trim() || [m.element_code, m.type].filter(Boolean).join(" · ") || "(unnamed budget line)",
        hint: [budget, left].filter(Boolean).join(" · ") || undefined,
      };
    }),
  }));

  async function assign(v: string) {
    if (!v || busy) return;
    setBusy(true); setErr(null);
    try {
      await api.assignPoLineBudget(poId, lineId, Number(v));
      const m = mats.find((x) => String(x.id) === v);
      setDoneLabel(m?.item ?? "assigned");
      onAssigned?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "couldn't assign");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 4, minWidth: ASSIGN_W }}>
      <GroupedCombobox
        groups={groups}
        value=""
        onChange={assign}
        placeholder={busy ? "Assigning…" : "Pick the budget line…"}
        searchPlaceholder="Search the materials budget…"
        ariaLabel="Budget line for this cost"
      />
      {err && <span style={{ fontSize: 11.5, color: "var(--danger)" }}>{err}</span>}
      <button className="ghost tiny" style={{ justifySelf: "start" }} disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
    </div>
  );
}
