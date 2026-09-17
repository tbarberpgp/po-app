// Tests that the invoice 3-way match survives a growing order book.
//
//   npm test
//
// The case: computeInvoiceMatch read every candidate order's lines with
// `WHERE po_id IN (?, ?, …)`, one bound parameter per live order. D1 accepts
// 100 bound parameters in a query. The company passed that on 11 Sep 2026 when
// PO-26001-0067 became the 101st live non-framework order on a live project,
// and from that moment the read threw `too many SQL variables` for EVERY
// project invoice.
//
// Nothing caught the throw, so /api/invoices/:id/match answered 500, and the
// Accounts match panel — which rendered its whole body only once the match had
// loaded — collapsed to a bare heading. The PO picker, the line table and the
// "+ Create PO from this invoice" button all vanished together, which read as
// a feature having been removed rather than as a screen that was broken.
//
// The fake below enforces the real ceiling, so any read that goes back to
// listing the ids fails here instead of in production.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { computeInvoiceMatch } from "./invoices";

/** D1's documented ceiling, verified against the live database: 100 bound
 *  parameters succeed, 101 throw `too many SQL variables at offset …`. */
const D1_MAX_BOUND_PARAMS = 100;

const LIVE_ORDERS = 104; // the live book on 17 Sep 2026

type Row = Record<string, unknown>;

/** Minimal D1 stand-in: routes each read by the table it names, and refuses
 *  any statement bound past the ceiling exactly as D1 does. */
function fakeDb(orders: Row[], lines: Row[], bindCounts: number[]) {
  const rowsFor = (sql: string): Row[] => {
    const q = sql.replace(/\s+/g, " ");
    if (q.includes("FROM po_lines")) return lines;
    if (q.includes("FROM purchase_orders")) {
      return q.includes("order_type = 'framework'")
        ? []
        : orders;
    }
    return [];
  };
  return {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          bound = args;
          bindCounts.push(args.length);
          if (args.length > D1_MAX_BOUND_PARAMS) {
            throw new Error(
              `D1_ERROR: too many SQL variables at offset 0: SQLITE_ERROR (${args.length} bound)`,
            );
          }
          return stmt;
        },
        async all<T>() {
          if (bound.length === 0) bindCounts.push(0);
          return { results: rowsFor(sql) as T[] };
        },
        async first<T>() {
          if (bound.length === 0) bindCounts.push(0);
          return (rowsFor(sql)[0] ?? null) as T | null;
        },
      };
      return stmt;
    },
  };
}

function buildBook(n: number) {
  const orders: Row[] = [];
  const lines: Row[] = [];
  for (let i = 1; i <= n; i++) {
    const id = `po-${i}`;
    orders.push({
      id,
      po_number: `PO-26001-${String(i).padStart(4, "0")}`,
      supplier: "Cut Price Insulation",
      project_id: "proj-26003",
      order_type: "materials",
      total_value: 1000,
      project_code: "26003",
    });
    lines.push({ id: i, po_id: id, item: "ROCKWOOL DUO SLAB 160MM", qty: 9, unit: "pack", unit_cost: 857.34 });
  }
  return { orders, lines };
}

const invoice = {
  id: 31531,
  supplier_name: "Cut Price Insulation",
  project_id: "proj-26003",
  matched_po_id: null,
  extracted_po_ref: null,
  net_amount: 6433.05,
  lines_json: JSON.stringify([
    { description: "ROCKWOOL DUO SLAB 160MM", qty: 9, unit_price: 857.34, amount: 7716.06 },
  ]),
};

describe("invoice match over a growing order book", () => {
  test("no read binds one parameter per live order", async () => {
    const { orders, lines } = buildBook(LIVE_ORDERS);
    const bindCounts: number[] = [];
    await computeInvoiceMatch({ DB: fakeDb(orders, lines, bindCounts) } as never, invoice);
    const worst = Math.max(...bindCounts);
    assert.ok(
      worst <= D1_MAX_BOUND_PARAMS,
      `a statement bound ${worst} parameters; D1 allows ${D1_MAX_BOUND_PARAMS}`,
    );
  });

  test("the picker still offers every live order past the old ceiling", async () => {
    const { orders, lines } = buildBook(LIVE_ORDERS);
    const m = await computeInvoiceMatch({ DB: fakeDb(orders, lines, []) } as never, invoice);
    assert.equal(m.suggested.length, LIVE_ORDERS, "every live order stays reachable in the picker");
  });

  // The order book only grows. 100 was crossed in September; the read must not
  // care where the number sits next year either.
  test("a much larger book is no different", async () => {
    const { orders, lines } = buildBook(500);
    const bindCounts: number[] = [];
    const m = await computeInvoiceMatch({ DB: fakeDb(orders, lines, bindCounts) } as never, invoice);
    assert.ok(Math.max(...bindCounts) <= D1_MAX_BOUND_PARAMS);
    assert.equal(m.suggested.length, 500);
  });
});
