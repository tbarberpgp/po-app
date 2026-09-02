// Tests for resolving a quoted PO reference to the order it really means.
//
//   npm test
//
// Every chain here is real. The Alumasc frameworks on 26001/26002/26003 were
// each raised, cancelled and raised again — twice — across 8 and 17 June, while
// suppliers went on quoting whichever number was current when they set the job
// up. Four invoices have quoted the superseded PO-26002-0003 so far.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { findSuccessor, SUPERSEDE_WINDOW_DAYS, type PoLifecycle } from "./poRef";

const ALUMASC = "Alumasc Water Management Solutions";
const J1 = "job-26001", J2 = "job-26002";

const po = (o: Partial<PoLifecycle> & { po_number: string }): PoLifecycle => ({
  id: o.po_number, status: "issued", order_type: "framework", supplier: ALUMASC,
  project_id: J2, created_at: null, deleted_at: null, ...o,
});

/** The 26002 framework chain, to the hour, as it sits in the book. */
const chain26002: PoLifecycle[] = [
  po({ po_number: "PO-26002-0002", status: "deleted", created_at: "2026-06-08T15:29:37Z", deleted_at: "2026-06-08T15:37:08Z" }),
  po({ po_number: "PO-26002-0003", status: "deleted", created_at: "2026-06-08T16:10:46Z", deleted_at: "2026-06-17T13:56:16Z" }),
  po({ po_number: "PO-26002-0004", status: "issued", created_at: "2026-06-17T16:28:38Z" }),
];

describe("findSuccessor", () => {
  test("the reference Alumasc keep quoting resolves to the live framework", () => {
    const dead = chain26002.find((p) => p.po_number === "PO-26002-0003")!;
    assert.equal(findSuccessor(dead, chain26002)?.po_number, "PO-26002-0004");
  });

  test("a replacement that was itself replaced is followed through", () => {
    // PO-26002-0002 was replaced by 0003, which was replaced by 0004. Only the
    // last is live, so stopping at the first hop would name a deleted order.
    const dead = chain26002.find((p) => p.po_number === "PO-26002-0002")!;
    assert.equal(findSuccessor(dead, chain26002)?.po_number, "PO-26002-0004");
  });

  test("the 26001 chain crosses a three-day gap and two dead hops", () => {
    // 0008 → 0010 (3.4 days) → 0011 (minutes) → 0013 (2.4 hours, live).
    const chain: PoLifecycle[] = [
      po({ po_number: "PO-26001-0008", project_id: J1, status: "deleted", created_at: "2026-06-04T21:55:00Z", deleted_at: "2026-06-05T07:00:00Z" }),
      po({ po_number: "PO-26001-0010", project_id: J1, status: "deleted", created_at: "2026-06-08T15:44:00Z", deleted_at: "2026-06-08T16:08:00Z" }),
      po({ po_number: "PO-26001-0011", project_id: J1, status: "deleted", created_at: "2026-06-08T16:09:00Z", deleted_at: "2026-06-17T13:54:00Z" }),
      po({ po_number: "PO-26001-0013", project_id: J1, status: "issued", created_at: "2026-06-17T16:17:00Z" }),
    ];
    assert.equal(findSuccessor(chain[0]!, chain)?.po_number, "PO-26001-0013");
  });

  test("an order abandoned rather than superseded resolves to nothing", () => {
    // The case the window exists for. Seven Alumasc orders on 26001 were
    // deleted and never replaced; the next Alumasc order on that job is
    // PO-26001-0028, a £559.78 order for a tin of primer raised 26 days later.
    // Naming it as the replacement would be worse than saying nothing.
    const abandoned: PoLifecycle[] = [
      po({ po_number: "PO-26001-0012", project_id: J1, order_type: "standard", status: "deleted", created_at: "2026-06-01T09:00:00Z", deleted_at: "2026-06-10T09:00:00Z" }),
      po({ po_number: "PO-26001-0028", project_id: J1, order_type: "standard", status: "issued", created_at: "2026-07-06T09:00:00Z" }),
    ];
    assert.equal(findSuccessor(abandoned[0]!, abandoned), null);
  });

  test("the window boundary is inclusive and holds either side", () => {
    const at = (days: number) => new Date(Date.parse("2026-06-10T09:00:00Z") + days * 86_400_000).toISOString();
    const build = (days: number): PoLifecycle[] => [
      po({ po_number: "DEAD", status: "deleted", created_at: "2026-06-01T09:00:00Z", deleted_at: "2026-06-10T09:00:00Z" }),
      po({ po_number: "LIVE", status: "issued", created_at: at(days) }),
    ];
    const inside = build(SUPERSEDE_WINDOW_DAYS);
    assert.equal(findSuccessor(inside[0]!, inside)?.po_number, "LIVE");
    const outside = build(SUPERSEDE_WINDOW_DAYS + 0.01);
    assert.equal(findSuccessor(outside[0]!, outside), null);
  });

  test("a different job, supplier or order type is not a replacement", () => {
    const dead = po({ po_number: "DEAD", status: "deleted", created_at: "2026-06-01T09:00:00Z", deleted_at: "2026-06-10T09:00:00Z" });
    const near = { created_at: "2026-06-10T12:00:00Z", status: "issued" as const };
    assert.equal(findSuccessor(dead, [dead, po({ po_number: "OTHER-JOB", project_id: J1, ...near })]), null);
    assert.equal(findSuccessor(dead, [dead, po({ po_number: "OTHER-SUPPLIER", supplier: "Fixfast Ltd", ...near })]), null);
    assert.equal(findSuccessor(dead, [dead, po({ po_number: "OTHER-TYPE", order_type: "call_off", ...near })]), null);
  });

  test("supplier and order type compare loosely enough to survive the data", () => {
    // order_type is nullable on rows raised before the call-off migration, and
    // reads as 'standard'. Supplier is free text, so case and padding vary.
    const dead = po({ po_number: "DEAD", order_type: null, supplier: "Fixfast Ltd", status: "deleted", created_at: "2026-06-01T09:00:00Z", deleted_at: "2026-06-10T09:00:00Z" });
    const live = po({ po_number: "LIVE", order_type: "standard", supplier: "  fixfast ltd ", status: "issued", created_at: "2026-06-10T12:00:00Z" });
    assert.equal(findSuccessor(dead, [dead, live])?.po_number, "LIVE");
  });

  test("an order with no deletion date can't be walked from", () => {
    const live = po({ po_number: "LIVE", created_at: "2026-06-10T12:00:00Z" });
    assert.equal(findSuccessor(po({ po_number: "NEVER-DELETED" }), [live]), null);
  });

  test("a cycle in the data terminates instead of spinning", () => {
    // Can only come from corrupt timestamps, but this walk is recursive and the
    // request budget is 30s of CPU.
    const a = po({ po_number: "A", status: "deleted", created_at: "2026-06-01T09:00:00Z", deleted_at: "2026-06-02T09:00:00Z" });
    const b = po({ po_number: "B", status: "deleted", created_at: "2026-06-02T10:00:00Z", deleted_at: "2026-06-01T08:00:00Z" });
    assert.equal(findSuccessor(a, [a, b]), null);
  });
});
