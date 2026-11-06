// Which PO an order acknowledgement is attached to — strict, like invoices and
// tickets: our number printed on it, or a supplier reference already tied to a
// PO. Everything else is only ever a suggestion for a person to confirm.
//
//   npm test
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolveAckPo } from "./order-acks";

const pos = [
  { id: "a100", po_number: "PO-26001-0100", project_code: "26001", supplier: "Alumasc Water Management Solutions", status: "pending_approval", total_value: 1315.4, created_at: "2026-10-28" },
  { id: "a098", po_number: "PO-26001-0098", project_code: "26001", supplier: "Alumasc Water Management Solutions", status: "pending_approval", total_value: 12050.22, created_at: "2026-10-26" },
  { id: "f093", po_number: "PO-26001-0093", project_code: "26001", supplier: "Fixfast Ltd", status: "approved", total_value: 1447.8, created_at: "2026-10-13" },
  { id: "f118", po_number: "PO-26001-0118", project_code: "26001", supplier: "Fixfast Ltd", status: "pending_approval", total_value: 361.3, created_at: "2026-11-06" },
  { id: "b104", po_number: "PO-26001-0104", project_code: "26001", supplier: "Barwell Spares & Service Ltd", status: "pending_approval", total_value: 3426.42, created_at: "2026-11-05" },
];
const base = { supplier_name: null, goods_total: null, total_ex_vat: null, carriage: null, delivery_address: null, our_po_ref: null } as const;

describe("resolveAckPo", () => {
  test("our PO number printed → attached", () => {
    const r = resolveAckPo({ ...base, supplier_name: "Alumasc Building Products", our_po_ref: "PO-26001-0100" }, pos, null);
    assert.deepEqual([r.po_id, r.matched_by], ["a100", "po_number"]);
  });

  test("our number written carelessly still counts", () => {
    const r = resolveAckPo({ ...base, supplier_name: "Fixfast", our_po_ref: "026001-0093" }, pos, null);
    assert.equal(r.po_id, "f093");
  });

  test("a site name where our number goes is never attached — only suggested", () => {
    const r = resolveAckPo({ ...base, supplier_name: "Alumasc Building Products", our_po_ref: "DALLAS RD BLOCK B", goods_total: 12050.22 }, pos, null);
    assert.equal(r.po_id, null);
    assert.equal(r.suggested_po_id, "a098");
    assert.match(r.suggest_reason ?? "", /total agrees/);
  });

  test("a delivery notice quoting a supplier ref we've already tied to a PO follows it", () => {
    const r = resolveAckPo({ ...base, supplier_name: "Fixfast Ltd" }, pos, { po_id: "f093" });
    assert.deepEqual([r.po_id, r.matched_by], ["f093", "supplier_ref"]);
  });

  test("two open orders with the supplier and nothing to tell them apart → no suggestion", () => {
    const r = resolveAckPo({ ...base, supplier_name: "Alumasc", our_po_ref: "TBC", goods_total: 500 }, pos, null);
    assert.deepEqual([r.po_id, r.suggested_po_id], [null, null]);
  });

  test("the only open order with that supplier is suggested, not attached", () => {
    const r = resolveAckPo({ ...base, supplier_name: "Barwell Spares and Service", our_po_ref: "TOM BARBER" }, pos, null);
    assert.equal(r.po_id, null);
    assert.equal(r.suggested_po_id, "b104");
  });
});
