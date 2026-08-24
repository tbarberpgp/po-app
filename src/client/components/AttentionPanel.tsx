// Needs attention — the unmatched invoices, gathered and named.
//
// The per-row badges tell you an invoice doesn't reconcile, but 40-odd of them
// scattered down a scrolling list is not something you can act on: you can't see
// that four Alumasc invoices all quote a PO they aren't linked to, and you can't
// see which ones are still stoppable. This panel answers both.
//
// The primary split is by what you can still DO about it, not by severity:
// an invoice that hasn't been approved can be fixed here and now, while one
// already in Xero needs a credit note or a conversation with the supplier.
import type { Invoice, MatchIssue } from "../../shared/types";
import { fmtMoney } from "../lib/api";

const money = (n: number | null | undefined, cur?: string | null) => (n == null ? "—" : fmtMoney(n, cur || "GBP"));

/** Reason kinds in the order a person should care about them. A wrong order link
 *  outranks everything else because it invalidates the price and quantity checks
 *  underneath it — those figures are measured against the wrong document. */
const KIND_ORDER: Array<MatchIssue["kind"]> = ["wrong_po", "cross_project", "over", "rate", "unlinked"];
const KIND_LABEL: Record<MatchIssue["kind"], string> = {
  wrong_po: "Quotes a different PO",
  cross_project: "PO on another job",
  over: "Billed over the order",
  rate: "Rate differs from PO",
  unlinked: "Line not on the PO",
};

/** The single reason to show on an invoice row — its most serious one. */
function topIssue(inv: Invoice): MatchIssue | null {
  const issues = inv.match?.issues ?? [];
  for (const k of KIND_ORDER) {
    const hit = issues.find((i) => i.kind === k);
    if (hit) return hit;
  }
  return null;
}

function issueText(i: MatchIssue, cur?: string | null): string {
  if (i.kind === "wrong_po") return `Invoice prints ${i.quoted} · linked to ${i.linked}`;
  if (i.kind === "cross_project") return `${i.linked} belongs to job ${i.po_project}`;
  if (i.kind === "unlinked") return `"${i.item.slice(0, 40)}" isn't on the PO`;
  if (i.kind === "rate") return `Billed ${money(i.billed, cur)} against ${money(i.ordered, cur)} ordered`;
  return `${money(i.billed, cur)} billed against ${money(i.ordered, cur)} ordered`;
}

type Group = { supplier: string; invoices: Invoice[]; excess: number };

/** Group by supplier, worst first. Ordered by money billed above the order, then
 *  by how many invoices are involved — a supplier with one £3,500 discrepancy
 *  needs chasing before one with six £20 ones. */
function group(rows: Invoice[]): Group[] {
  const by = new Map<string, Group>();
  for (const r of rows) {
    const supplier = r.supplier_name || r.matched_supplier_name || "Unknown supplier";
    const g = by.get(supplier) ?? { supplier, invoices: [], excess: 0 };
    g.invoices.push(r);
    g.excess += r.match?.excess ?? 0;
    by.set(supplier, g);
  }
  return [...by.values()]
    .map((g) => ({ ...g, invoices: g.invoices.slice().sort((a, b) => (b.match?.excess ?? 0) - (a.match?.excess ?? 0)) }))
    .sort((a, b) => b.excess - a.excess || b.invoices.length - a.invoices.length);
}

function Section({ title, note, rows, onSelect, tone }: {
  title: string; note: string; rows: Invoice[]; onSelect: (id: number) => void; tone: "open" | "done";
}) {
  if (!rows.length) return null;
  const groups = group(rows);
  const excess = rows.reduce((s, r) => s + (r.match?.excess ?? 0), 0);
  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 2 }}>
        <h3 style={{ margin: 0, fontSize: 14, color: tone === "open" ? "var(--danger)" : "var(--ink)" }}>
          {title} <span style={{ color: "var(--muted)", fontWeight: 500 }}>({rows.length})</span>
        </h3>
        {excess > 0.005 && <span style={{ fontSize: 12, color: "var(--muted)" }}>{money(excess)} above order</span>}
      </div>
      <p style={{ margin: "0 0 10px", fontSize: 11.5, color: "var(--muted)", lineHeight: 1.5, maxWidth: "62ch" }}>{note}</p>

      {groups.map((g) => (
        <div key={g.supplier} style={{ border: "1px solid var(--line)", borderRadius: 8, marginBottom: 8, overflow: "hidden" }}>
          <div style={{
            display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap",
            padding: "8px 12px", background: "var(--card-2)", borderBottom: "1px solid var(--line)",
          }}>
            <b style={{ fontSize: 12.5 }}>{g.supplier}</b>
            <span style={{ fontSize: 11.5, color: "var(--muted)" }}>
              {g.invoices.length} invoice{g.invoices.length === 1 ? "" : "s"}
            </span>
            {g.excess > 0.005 && (
              <span style={{ fontSize: 11.5, color: "var(--danger)", fontWeight: 600, marginLeft: "auto" }}>
                {money(g.excess)} over
              </span>
            )}
          </div>
          {g.invoices.map((r) => {
            const top = topIssue(r);
            const more = (r.match?.issues.length ?? 0) - 1;
            return (
              <button key={r.id} onClick={() => onSelect(r.id)} style={{
                display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: "2px 12px", width: "100%",
                textAlign: "left", padding: "9px 12px", background: "transparent", border: 0,
                borderTop: "1px solid var(--line)", cursor: "pointer", font: "inherit", color: "inherit",
              }}>
                <span style={{ fontSize: 12.5, fontWeight: 600, minWidth: 0 }}>
                  {r.invoice_number ? `#${r.invoice_number}` : "no invoice #"}
                  {r.project_code && <span style={{ color: "var(--muted)", fontWeight: 500 }}> · job {r.project_code}</span>}
                </span>
                <span style={{ fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap" }}>{money(r.gross_amount, r.currency)}</span>
                <span style={{ fontSize: 11.5, color: "var(--danger)", minWidth: 0 }}>
                  {top ? `${KIND_LABEL[top.kind]} — ${issueText(top, r.currency)}` : "Unmatched"}
                  {more > 0 && <span style={{ color: "var(--muted)" }}> · +{more} more</span>}
                </span>
                <span style={{ fontSize: 11.5, color: "var(--muted)", whiteSpace: "nowrap" }}>
                  {(r.match?.excess ?? 0) > 0.005 ? `${money(r.match!.excess, r.currency)} over` : ""}
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export function AttentionPanel({ rows, onSelect }: { rows: Invoice[]; onSelect: (id: number) => void }) {
  const unmatched = rows.filter((r) => r.match && r.match.state !== "matched" && r.status !== "dismissed");

  if (!unmatched.length) {
    return (
      <div className="a-card a-pad">
        <div className="eyebrow" style={{ marginBottom: 6 }}>Needs attention</div>
        <div className="muted" style={{ fontSize: 13 }}>
          Every invoice with a purchase order reconciles on price and quantity. Nothing to chase.
        </div>
      </div>
    );
  }

  // Approval is the point of no return: it pushes a draft bill to Xero, so an
  // unapproved invoice is still correctable in place and an approved one isn't.
  const open = unmatched.filter((r) => !r.approved_at);
  const done = unmatched.filter((r) => r.approved_at);
  const counts = KIND_ORDER
    .map((k) => [k, unmatched.filter((r) => r.match?.issues.some((i) => i.kind === k)).length] as const)
    .filter(([, n]) => n > 0);

  return (
    <div className="a-card a-pad">
      <div className="eyebrow" style={{ marginBottom: 6 }}>Needs attention</div>
      <p style={{ margin: "0 0 12px", fontSize: 13, lineHeight: 1.55, maxWidth: "62ch" }}>
        <b>{unmatched.length} invoice{unmatched.length === 1 ? "" : "s"}</b> don't reconcile against the purchase order
        they're linked to. Deliveries aren't part of this — only price, quantity and which order is linked.
      </p>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 4 }}>
        {counts.map(([k, n]) => (
          <span key={k} className="pill" style={{
            fontSize: 10.5, background: "var(--card-2)", color: "var(--ink-2)", border: "1px solid var(--line)",
          }}>{KIND_LABEL[k]} <b>{n}</b></span>
        ))}
      </div>

      <Section
        tone="open"
        title="Not approved yet — still fixable"
        note="Nothing has gone to Xero for these. Correct the PO link, mark a service line as a service charge, or take it up with the supplier before approving."
        rows={open}
        onSelect={onSelect}
      />
      <Section
        tone="done"
        title="Already approved"
        note="A draft bill is in Xero for each of these. Fixing the link here won't change Xero — amend or void the bill there, and chase a credit note where the money is genuinely over."
        rows={done}
        onSelect={onSelect}
      />
    </div>
  );
}
