import type { ReactNode } from "react";

/**
 * A reusable right-hand slide-over that explains a single headline figure by
 * listing the exact rows that make it up — "click the number, see what's behind
 * it". Used on both the per-project Commercials/Materials tabs and the combined
 * group page. Purely presentational: each caller builds the `DrillData` (title,
 * columns, rows, total) from whatever data it already has, and toggles it via a
 * `useState<DrillData | null>`.
 *
 * Reuses the existing `.od-scrim`/`.od-drawer` drawer styling (see styles.css)
 * so it matches the operative-detail slide-over.
 */
export type DrillAlign = "left" | "right" | "center";

export type DrillColumn = {
  key: string;
  label: string;
  align?: DrillAlign;
  /** Custom cell renderer; receives the cell value and the whole row. */
  fmt?: (value: unknown, row: Record<string, unknown>) => ReactNode;
};

export type DrillData = {
  title: string;
  /** Headline value of the figure being explained, e.g. "£12,654". */
  value?: string;
  subtitle?: string;
  columns: DrillColumn[];
  rows: Array<Record<string, unknown>>;
  /** Optional footer total aligned under the last (numeric) column. */
  total?: string;
  totalLabel?: string;
  note?: string;
  /** Arbitrary content rendered under the table (e.g. an inline edit form). */
  footer?: ReactNode;
};

const cls = (a?: DrillAlign) => (a === "right" ? "num" : a === "center" ? "center" : undefined);

export function DrillPanel({ drill, onClose }: { drill: DrillData | null; onClose: () => void }) {
  const open = drill != null;
  return (
    <>
      <div className={`drill-scrim${open ? " show" : ""}`} aria-hidden onClick={onClose} />
      <aside
        className={`od-drawer${open ? " open" : ""}`}
        role="dialog"
        aria-modal="false"
        aria-label={drill?.title ?? "Detail"}
      >
        {drill && (
          <div className="od-inner">
            <div className="card-hd od-hd" style={{ alignItems: "flex-start", gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <h3 style={{ margin: 0 }}>{drill.title}</h3>
                {drill.value != null && (
                  <div style={{ fontSize: 22, fontWeight: 700, marginTop: 2 }}>{drill.value}</div>
                )}
                {drill.subtitle && (
                  <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>{drill.subtitle}</div>
                )}
              </div>
              <button className="ghost tiny" onClick={onClose} aria-label="Close">✕</button>
            </div>
            <div style={{ padding: "4px 16px 24px" }}>
              {drill.rows.length === 0 ? (
                <div className="empty in-card"><p>Nothing has contributed to this figure yet.</p></div>
              ) : (
                <table className="drill-table">
                  <thead>
                    <tr>{drill.columns.map((c) => <th key={c.key} className={cls(c.align)}>{c.label}</th>)}</tr>
                  </thead>
                  <tbody>
                    {drill.rows.map((r, i) => (
                      r.__header ? (
                        // Section row: a group label (with an optional swatch tying it
                        // to the chart series colour) and the group's subtotal.
                        <tr key={i}>
                          <td colSpan={Math.max(1, drill.columns.length - 1)}
                            style={{ paddingTop: i === 0 ? 6 : 18, fontWeight: 700, borderBottom: "2px solid var(--line-strong)" }}>
                            {typeof r.__color === "string" && (
                              <span aria-hidden style={{ display: "inline-block", width: 9, height: 9, borderRadius: 2, background: r.__color, marginRight: 7 }} />
                            )}
                            {r.__header as ReactNode}
                          </td>
                          <td className="num" style={{ paddingTop: i === 0 ? 6 : 18, fontWeight: 700, borderBottom: "2px solid var(--line-strong)" }}>
                            {(r.__total as ReactNode) ?? ""}
                          </td>
                        </tr>
                      ) : (
                        <tr key={i}>
                          {drill.columns.map((c) => (
                            <td key={c.key} className={cls(c.align)}>
                              {c.fmt ? c.fmt(r[c.key], r) : ((r[c.key] as ReactNode) ?? "—")}
                            </td>
                          ))}
                        </tr>
                      )
                    ))}
                  </tbody>
                  {drill.total != null && (
                    <tfoot>
                      <tr>
                        <td colSpan={Math.max(1, drill.columns.length - 1)} style={{ textAlign: "right", fontWeight: 700 }}>
                          {drill.totalLabel ?? "Total"}
                        </td>
                        <td className="num" style={{ fontWeight: 700 }}>{drill.total}</td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              )}
              {drill.footer}
              {drill.note && <p className="muted" style={{ fontSize: 12, marginTop: 14 }}>{drill.note}</p>}
            </div>
          </div>
        )}
      </aside>
    </>
  );
}

/** A KPI tile that opens its drill-down on click. Mirrors the local `Kpi`
 *  components but adds the affordance + keyboard support. */
export function DrillKpi({
  label, value, sub, tone, onOpen,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "default" | "success" | "danger" | "warn";
  onOpen?: () => void;
}) {
  const toneCls = tone && tone !== "default" ? ` tone-${tone}` : "";
  if (!onOpen) {
    return (
      <div className={`kpi${toneCls}`}>
        <div className="kpi-label">{label}</div>
        <div className="kpi-value">{value}</div>
        {sub && <div className="kpi-sub">{sub}</div>}
      </div>
    );
  }
  return (
    <button type="button" className={`kpi drillable${toneCls}`} onClick={onOpen} aria-label={`${label} — view breakdown`}>
      <div className="kpi-label">{label}<span className="drill-cue" aria-hidden>›</span></div>
      <div className="kpi-value">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </button>
  );
}
