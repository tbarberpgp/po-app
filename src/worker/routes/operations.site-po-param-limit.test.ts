// Tests that the per-site delivery routes survive a growing site order book.
//
//   npm test
//
// The case: three reads keyed on "the purchase orders on this site" listed
// those orders' ids as bound parameters. D1 accepts 100 per query. This looked
// safe where the cross-project inbox obviously wasn't — a site is only a site —
// but `siteScope` spans every contract in a site GROUP, and one group already
// holds 93 live non-framework orders. The next handful would have taken out the
// ticket matcher and the delivery burn-down.
//
// Each sits inside a try/catch or feeds a list the UI renders empty, so the
// failure would have been a quiet screen rather than an error — the same shape
// that made "+ Create PO from this invoice" look deleted when
// computeInvoiceMatch overflowed the same ceiling.
//
// The fake enforces the real ceiling, so a read that goes back to listing ids
// fails here instead of on site.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { operations } from "./operations";

/** D1's documented ceiling, verified against the live database. */
const D1_MAX_BOUND_PARAMS = 100;

/** One site group's live order book as of 2026-09-17. */
const SITE_ORDERS = 93;
const MEMBERS = ["proj-a", "proj-b", "proj-c"];

type Row = Record<string, unknown>;

function fakeEnv(orderCount: number, bindCounts: number[]) {
  const orders: Row[] = [];
  const lines: Row[] = [];
  for (let i = 1; i <= orderCount; i++) {
    const id = `po-${i}`;
    orders.push({
      id, po_number: `PO-26001-${String(i).padStart(4, "0")}`, supplier: "Fixfast Ltd",
      order_type: "materials", status: "approved", project_id: MEMBERS[i % MEMBERS.length],
      project_code: "26001",
    });
    lines.push({ id: i, po_id: id, item: "SDK5.5 fastener 1HR", qty: 10, unit: "box", unit_cost: 52.9 });
  }

  const rowsFor = (sql: string): Row[] => {
    const q = sql.replace(/\s+/g, " ");
    // siteScope: the group, then its members.
    if (q.includes("FROM projects p JOIN site_groups g")) {
      return [{ gid: "grp-1", gname: "Dallas Rd", base: MEMBERS[0] }];
    }
    if (q.includes("FROM projects WHERE site_group_id")) return MEMBERS.map((id) => ({ id }));
    // The ticket being matched, with items that hit the order lines.
    if (q.includes("FROM delivery_ticket_scans")) {
      return [{
        id: 1, project_id: MEMBERS[0], status: "pending",
        extracted_json: JSON.stringify({ items: [{ description: "SDK5.5 fastener 1HR", qty: 10, unit: "box" }] }),
      }];
    }
    if (q.includes("FROM po_lines")) return lines;
    if (q.includes("FROM purchase_orders")) return orders;
    return [];
  };

  const DB = {
    prepare(sql: string) {
      let bound = false;
      const stmt = {
        bind(...args: unknown[]) {
          bound = true;
          bindCounts.push(args.length);
          if (args.length > D1_MAX_BOUND_PARAMS) {
            throw new Error(`D1_ERROR: too many SQL variables at offset 0: SQLITE_ERROR (${args.length} bound)`);
          }
          return stmt;
        },
        async all<T>() { if (!bound) bindCounts.push(0); return { results: rowsFor(sql) as T[] }; },
        async first<T>() { if (!bound) bindCounts.push(0); return (rowsFor(sql)[0] ?? null) as T | null; },
        async run() { if (!bound) bindCounts.push(0); return { success: true }; },
      };
      return stmt;
    },
    async batch() { return []; },
  };
  return { DB } as never;
}

const ROUTES = [
  ["ticket PO-guess", "/proj-a/deliveries/ticket-candidates/1/suggest"],
  ["ticket reconcile", "/proj-a/deliveries/ticket-candidates/1/reconcile"],
  ["delivery burn-down", "/proj-a/deliveries/po-status"],
] as const;

describe("per-site PO reads over a growing site order book", () => {
  for (const [name, path] of ROUTES) {
    test(`${name} binds nothing that grows with the order book`, async () => {
      const bindCounts: number[] = [];
      const res = await operations.request(path, {}, fakeEnv(SITE_ORDERS, bindCounts));
      assert.equal(res.status, 200, `${name} answered ${res.status}`);
      const worst = Math.max(...bindCounts);
      assert.ok(
        worst <= D1_MAX_BOUND_PARAMS,
        `${name} bound ${worst} parameters; D1 allows ${D1_MAX_BOUND_PARAMS}`,
      );
      // Only the site's member projects are ever listed.
      assert.ok(worst <= MEMBERS.length + 1, `${name} bound ${worst}, expected at most one per member project`);
    });
  }

  // Binding nothing is easy to achieve by reading nothing. The ticket here
  // quotes an item that IS on the site's orders, so the guess must still find
  // it — proving the join returns the same lines the id list used to, not an
  // empty set that trivially satisfies the bind-count assertions above. Live
  // data can't cover this: no ticket in it shares a material code with an
  // order line, so every ranking there comes back empty either way.
  test("the PO guess still finds the order carrying the ticket's item", async () => {
    const res = await operations.request(
      "/proj-a/deliveries/ticket-candidates/1/suggest", {}, fakeEnv(SITE_ORDERS, []),
    );
    assert.equal(res.status, 200);
    const body = await res.json() as { suggested_po_id: string | null; ranked: Array<{ hits: number }> };
    assert.ok(body.ranked.length > 0, "the guess ranked nothing, so the line read came back empty");
    assert.ok(body.suggested_po_id, "no PO suggested despite a matching item code");
    assert.ok(body.ranked[0].hits > 0, "top-ranked order records no item hits");
  });

  for (const [name, path] of ROUTES) {

    test(`${name} is no different at ten times the orders`, async () => {
      const bindCounts: number[] = [];
      const res = await operations.request(path, {}, fakeEnv(SITE_ORDERS * 10, bindCounts));
      assert.equal(res.status, 200);
      assert.ok(Math.max(...bindCounts) <= D1_MAX_BOUND_PARAMS);
    });
  }
});
