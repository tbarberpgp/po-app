// The order picker behind a delivery check-in: what it offers, and what it is
// still not allowed to decide.
//
//   npm test
//
// The picker used to be a flat <select> of the site's order book, and the
// button above it read "Check in against PO-26003-0040" — so a wrongly matched
// ticket had no visible way back, and people stopped looking for one. The
// endpoint behind it was no better: it answered only with orders carrying the
// ticket's own item codes, and answered `ranked: []` outright when the ticket
// had no legible codes at all. The Alumasc cylinder note is exactly that case —
// a 74% supplier match, no product codes our orders share — so the one screen
// meant to correct a bad match offered nothing to correct it with.
//
// Two separate jobs, and conflating them is how goods get booked against the
// wrong order:
//
//   `ranked` is what the app may ACT on — it pre-selects an order for someone,
//   so it stays item-code evidence only.
//   `candidates` is what a PERSON chooses from — every live order on the site,
//   ordered by likelihood, never trimmed.
//
// These tests hold that line: a supplier-name match earns a place near the top
// of the list and must never earn a pre-selection.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { operations } from "./operations";

type Row = Record<string, unknown>;
type Candidate = {
  id: string; po_number: string; supplier: string | null; project_id: string;
  hits: number; supplier_match: number; group: "quoted" | "likely" | "other"; why: string | null;
};
type Body = {
  suggested_po_id: string | null;
  ranked: Array<{ id: string; hits: number }>;
  quoted_po_id: string | null;
  candidates: Candidate[];
};

const MEMBERS = ["proj-a", "proj-b"];

/** A site holding four live orders, and one ticket to place against them. */
function fakeEnv(ticket: { items: string[]; supplier: string | null; po_number: string | null }) {
  const orders: Row[] = [
    // Carries the ticket's item code — the only evidence strong enough to choose.
    { id: "po-codes", po_number: "PO-26001-0011", supplier: "Fixfast Ltd", order_type: "materials", project_id: "proj-a", project_code: "26001" },
    // Same supplier as the ticket, nothing else in common.
    { id: "po-supplier", po_number: "PO-26001-0022", supplier: "Alumasc Building Products Ltd", order_type: "materials", project_id: "proj-a", project_code: "26001" },
    // The number printed on the ticket, on a SIBLING contract in the site group.
    { id: "po-quoted", po_number: "PO-26002-0033", supplier: "Freightroute", order_type: "materials", project_id: "proj-b", project_code: "26002" },
    // No connection to the ticket whatsoever. Must still be reachable.
    { id: "po-unrelated", po_number: "PO-26001-0044", supplier: "SIG Roofing", order_type: "materials", project_id: "proj-a", project_code: "26001" },
  ];
  const lines: Row[] = [
    { id: 1, po_id: "po-codes", item: "SDK5.5 fastener 1HR", qty: 10, unit: "box" },
    { id: 2, po_id: "po-supplier", item: "HWF100 hopper head", qty: 4, unit: "nr" },
    { id: 3, po_id: "po-quoted", item: "TRAY200 gutter tray", qty: 6, unit: "nr" },
    { id: 4, po_id: "po-unrelated", item: "MEMB3 breather membrane", qty: 2, unit: "roll" },
  ];

  const rowsFor = (sql: string): Row[] => {
    const q = sql.replace(/\s+/g, " ");
    if (q.includes("FROM projects p JOIN site_groups g")) return [{ gid: "grp-1", gname: "Dallas Rd", base: MEMBERS[0] }];
    if (q.includes("FROM projects WHERE site_group_id")) return MEMBERS.map((id) => ({ id }));
    if (q.includes("FROM delivery_ticket_scans")) {
      return [{
        extracted_json: JSON.stringify({ items: ticket.items.map((description) => ({ description })) }),
        po_number: ticket.po_number,
        supplier_name: ticket.supplier,
      }];
    }
    if (q.includes("FROM po_lines")) return lines;
    if (q.includes("FROM purchase_orders")) return orders;
    return [];
  };

  const DB = {
    prepare(sql: string) {
      const stmt = {
        bind() { return stmt; },
        async all<T>() { return { results: rowsFor(sql) as T[] }; },
        async first<T>() { return (rowsFor(sql)[0] ?? null) as T | null; },
        async run() { return { success: true }; },
      };
      return stmt;
    },
    async batch() { return []; },
  };
  return { DB } as never;
}

async function suggest(ticket: { items: string[]; supplier: string | null; po_number: string | null }): Promise<Body> {
  const res = await operations.request("/proj-a/deliveries/ticket-candidates/1/suggest", {}, fakeEnv(ticket));
  assert.equal(res.status, 200);
  return await res.json() as Body;
}

/** The Alumasc cylinder note: a clear supplier, no product code we share. */
const SUPPLIER_ONLY = { items: ["UN3501 Chemical Under Pressure, Flammable"], supplier: "Alumasc Building Products", po_number: null };

describe("the order picker on a delivery check-in", () => {
  test("offers every live order on the site, including ones nothing points at", async () => {
    const body = await suggest(SUPPLIER_ONLY);
    assert.deepEqual(
      body.candidates.map((cnd) => cnd.id).sort(),
      ["po-codes", "po-quoted", "po-supplier", "po-unrelated"],
      "an order was dropped from the picker — every order on the site has to stay pickable",
    );
  });

  test("a supplier match is offered high, and still never pre-selects", async () => {
    const body = await suggest(SUPPLIER_ONLY);
    const alumasc = body.candidates.find((cnd) => cnd.id === "po-supplier")!;
    assert.equal(alumasc.group, "likely", "the ticket's own supplier wasn't offered as a likely order");
    assert.equal(body.candidates[0].id, "po-supplier", "the likely order isn't at the top of the list");
    assert.equal(alumasc.why, "same supplier", "no reason shown beside the suggestion");
    // The part that must not move. Pre-selecting on a name alone books goods
    // against whichever of a supplier's dozen live orders happened to rank first.
    assert.equal(body.suggested_po_id, null, "a supplier-name match pre-selected an order");
    assert.deepEqual(body.ranked, [], "a supplier-name match reached `ranked`, which the UI acts on");
  });

  test("an item-code match still pre-selects, as it always did", async () => {
    const body = await suggest({ items: ["SDK5.5 fastener 1HR"], supplier: "Fixfast", po_number: null });
    assert.equal(body.suggested_po_id, "po-codes");
    assert.equal(body.ranked[0]?.id, "po-codes");
    assert.ok(body.ranked[0].hits > 0);
    assert.equal(body.candidates.find((cnd) => cnd.id === "po-codes")!.group, "likely");
  });

  test("the number printed on the ticket leads the list, through the supplier's own rendering of it", async () => {
    // Freightroute print our 26002 order zero-padded and slashed.
    const body = await suggest({ items: [], supplier: null, po_number: "026002/0033" });
    assert.equal(body.quoted_po_id, "po-quoted");
    assert.equal(body.candidates[0].id, "po-quoted", "the order printed on the ticket isn't first");
    assert.equal(body.candidates[0].group, "quoted");
    // On a sibling contract — the picker has to hand back the job as well, or
    // choosing it would check the delivery in against the wrong one.
    assert.equal(body.candidates[0].project_id, "proj-b");
  });

  test("a ticket nothing matches still gets the whole order book, not an empty picker", async () => {
    // The old endpoint answered `ranked: []` and stopped here, which is what
    // left the Alumasc note with no way to choose an order at all.
    const body = await suggest({ items: [], supplier: null, po_number: null });
    assert.equal(body.candidates.length, 4);
    assert.ok(body.candidates.every((cnd) => cnd.group === "other"));
    assert.equal(body.suggested_po_id, null);
  });
});
