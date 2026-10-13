// Each subcontractor's labour invoices, as the Labour subtab shows them.
//
//   npm test
//
// Figures are Blyth (26004) as it stood in the live database on 13 Oct 2026:
// Paul Garbutt's fifteen invoices and Cladders' applications.
import { test } from "node:test";
import assert from "node:assert/strict";
import { labourBySubcontractor, type LabourInvoiceRow } from "./afp-list";

const GARBUTT = 7, CLADDERS = 3;
let id = 0;
const app = (supplier: number, status: string, net: number, period_end: string, file: string, extra: Partial<LabourInvoiceRow> = {}): LabourInvoiceRow => ({
  id: ++id, app_number: id, direction: "incoming_labour", status, period_end,
  counterparty_supplier_id: supplier, this_period_net: net, source_file_name: file,
  payment_reference: status === "paid" ? `Paid in Xero — ${file}` : null, ...extra,
});

const garbutt = [
  app(GARBUTT, "paid", 2016.58, "2026-06-29", "INV-001"),
  app(GARBUTT, "paid", 3300, "2026-07-10", "INV-002"),
  app(GARBUTT, "paid", 3300, "2026-07-13", "INV-003"),
  app(GARBUTT, "paid", 3300, "2026-07-23", "INV-004"),
  app(GARBUTT, "paid", 1650, "2026-07-30", "INV-005"),
  app(GARBUTT, "paid", 2750, "2026-08-14", "INV-007"),
  app(GARBUTT, "paid", 2750, "2026-08-14", "INV-006"),
  app(GARBUTT, "paid", 2750, "2026-08-20", "INV-008"),
  app(GARBUTT, "paid", 3300, "2026-09-04", "INV-009"),
  app(GARBUTT, "paid", 3300, "2026-09-04", "INV-010"),
  app(GARBUTT, "paid", 1650, "2026-09-10", "INV-011"),
  app(GARBUTT, "paid", 3300, "2026-09-17", "INV-012"),
  app(GARBUTT, "paid", 3850, "2026-10-01", "INV-013"),
  app(GARBUTT, "paid", 3300, "2026-10-01", "INV-014"),
  app(GARBUTT, "submitted", 3850, "2026-10-08", "Invoice 15.pdf"),
];
const cladders = [
  app(CLADDERS, "certified", 2196, "2026-07-03", "CLADDERS LTD copy.docx"),
  app(CLADDERS, "certified", 7480.8, "2026-07-10", "CLADDERS LTD copy copy.docx"),
  app(CLADDERS, "submitted", 3511.21, "2026-07-12", "CLADDERS LTD copy.pdf"),
  app(CLADDERS, "draft", 5328, "2026-07-17", "CLADDERS LTD copy.docx"),
  app(CLADDERS, "submitted", 0, "2026-08-14", "CLADDERS LTD copy.docx"),
  app(CLADDERS, "submitted", 9504, "2026-10-08", "Cladders Inv 12.pdf"),
];

test("Blyth: each subcontractor's money adds up to the Labour subtab's KPIs", () => {
  const rows = labourBySubcontractor([...cladders, ...garbutt]);
  assert.deepEqual(rows.map((r) => r.supplierId), [GARBUTT, CLADDERS], "largest spend first");
  const [g, c] = rows;
  assert.equal(g.invoices.length, 15);
  assert.equal(g.spent, 40516.58);
  assert.equal(g.paid, 40516.58);
  assert.equal(g.awaiting, 3850);
  assert.equal(c.spent, 9676.8);
  assert.equal(c.paid, 0);
  assert.equal(c.notCounted, 5328);
  // Amount expended £50,193.38 and awaiting certification £16,865.21 on the live page.
  assert.equal(Math.round((g.spent + c.spent) * 100) / 100, 50193.38);
  assert.equal(Math.round((g.awaiting + c.awaiting) * 100) / 100, 16865.21);
});

test("invoices list oldest first, same-day invoices in invoice order", () => {
  const [g] = labourBySubcontractor(garbutt);
  assert.deepEqual(
    g.invoices.slice(5, 7).map((a) => a.source_file_name),
    ["INV-006", "INV-007"],
  );
  assert.equal(g.invoices[0].source_file_name, "INV-001");
  assert.equal(g.invoices[14].source_file_name, "Invoice 15.pdf");
});

test("prelims drawdowns and other directions are left out", () => {
  const rows = labourBySubcontractor([
    app(GARBUTT, "certified", 1000, "2026-07-01", "INV-100", { prelim_heading: "Site management", claimed_amount: 1000 }),
    app(GARBUTT, "certified", 500, "2026-07-01", "INV-101", { direction: "outgoing" }),
    app(GARBUTT, "certified", 250, "2026-07-01", "INV-102"),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].spent, 250);
  assert.equal(rows[0].invoices.length, 1);
});
