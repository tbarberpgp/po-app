// Restating a subcontractor's applications from their invoices.
//
//   npm test
//
// The case is Paul Garbutt on Blyth, as it stands on 12 Oct 2026: fifteen
// weekly invoices for £44,366.58, fourteen paid in Xero, read £9,346 in the
// app — ten applications at £0, #23 at £6,046 against a £3,850 invoice, and
// £2,196 of Cladders' work riding on his lines from #3 onward.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  planRestatement, lineWrites, settleWrites, paymentReference,
  type RestateAppRow, type RestateLineRow, type RestateRequest, type RestateStep,
} from "./labour-restatement";
import { periodNet } from "./routes/applications";
import { LABOUR_POSITION, PRELIM_LABOUR_BY_PROJECT } from "./labour-expended";

const P = "blyth";
const GARBUTT = 51;
const CLADDERS = 7;
const PM = 1858; // Prelims — Project Manager Whole Scope, £48,000
const FLASHINGS = [1865, 1866, 1867];

/** Garbutt's series as the live database holds it. */
const LIVE: Array<{ id: number; n: number; status: string; net: number; cert: number | null; pm: number; fl: number[]; inv: string; works: number; paid: boolean; att?: boolean }> = [
  { id: 54, n: 3, status: "certified", net: 3300, cert: 3300, pm: 3300, fl: [828, 648, 720], inv: "INV-002", works: 3300, paid: true },
  { id: 63, n: 9, status: "submitted", net: 0, cert: null, pm: 3300, fl: [0, 0, 0], inv: "INV-004", works: 3300, paid: true },
  { id: 68, n: 10, status: "submitted", net: 0, cert: null, pm: 1650, fl: [0, 0, 0], inv: "INV-005", works: 1650, paid: true },
  { id: 73, n: 12, status: "submitted", net: 0, cert: null, pm: 2750, fl: [0, 0, 0], inv: "INV-007", works: 2750, paid: true },
  { id: 75, n: 14, status: "submitted", net: 0, cert: null, pm: 2750, fl: [0, 0, 0], inv: "INV-006", works: 2750, paid: true },
  { id: 77, n: 16, status: "submitted", net: 0, cert: null, pm: 2750, fl: [0, 0, 0], inv: "INV-008", works: 2750, paid: true },
  { id: 81, n: 18, status: "submitted", net: 0, cert: null, pm: 3300, fl: [0, 0, 0], inv: "INV-009", works: 3300, paid: true },
  { id: 82, n: 19, status: "submitted", net: 0, cert: null, pm: 3300, fl: [0, 0, 0], inv: "INV-010", works: 3300, paid: true },
  { id: 83, n: 20, status: "submitted", net: 0, cert: null, pm: 1650, fl: [0, 0, 0], inv: "INV-011", works: 1650, paid: true },
  { id: 87, n: 22, status: "submitted", net: 0, cert: null, pm: 3300, fl: [0, 0, 0], inv: "INV-012", works: 3300, paid: true },
  { id: 92, n: 23, status: "submitted", net: 6046, cert: null, pm: 31900, fl: [828, 648, 720], inv: "INV-013", works: 3850, paid: true, att: true },
  { id: 94, n: 25, status: "submitted", net: 0, cert: null, pm: 48000, fl: [1656, 1296, 1440], inv: "INV-014", works: 3300, paid: true },
  { id: 96, n: 27, status: "submitted", net: 0, cert: null, pm: 48000, fl: [3312, 2592, 2880], inv: "INV-015", works: 3850, paid: false },
  // INV-001 and INV-003, uploaded as drafts before the restatement runs.
  { id: 200, n: 29, status: "draft", net: 0, cert: null, pm: 1650, fl: [0, 0, 0], inv: "INV-001", works: 1650, paid: true },
  { id: 201, n: 30, status: "draft", net: 0, cert: null, pm: 3300, fl: [0, 0, 0], inv: "INV-003", works: 3300, paid: true },
];
const LAPTOP = { description: "IT Equipment (Laptop, bag and mouse)", amount: 366.58 };

function appRow(x: (typeof LIVE)[number], over: Partial<RestateAppRow> = {}): RestateAppRow {
  return {
    id: x.id, project_id: P, direction: "incoming_labour", app_number: x.n, status: x.status,
    counterparty_supplier_id: GARBUTT, prelim_heading: null, claimed_amount: null, claim_basis: null,
    xero_po_id: null, retention_pct: 0, vat_pct: 0, cumulative_value: x.pm + x.fl.reduce((s, v) => s + v, 0),
    this_period_net: x.net, certified_amount: x.cert, attention_note: x.att ? "Invoice INV 013 is £3,850…" : null,
    unmatched_lines_json: null, resolved_lines_json: null, ...over,
  };
}
function lineRows(x: (typeof LIVE)[number]): RestateLineRow[] {
  const out: RestateLineRow[] = [{
    id: x.id * 100 + 1, afp_id: x.id, contract_item_id: PM, section: "Prelims", description: "Project Manager Whole Scope",
    contract_value: 48000, cumulative_value: x.pm, is_adhoc: 0, variation_id: null, display_order: 1,
  }];
  FLASHINGS.forEach((ci, i) => out.push({
    id: x.id * 100 + 2 + i, afp_id: x.id, contract_item_id: ci, section: "Removal of Flashings", description: `Flashing item ${ci}`,
    contract_value: 7710, cumulative_value: x.fl[i], is_adhoc: 0, variation_id: null, display_order: 2 + i,
  }));
  return out;
}
const APPS = () => LIVE.map((x) => appRow(x));
const LINES = () => LIVE.flatMap(lineRows);
function request(over: Partial<RestateRequest> = {}): RestateRequest {
  return {
    project_id: P, supplier_id: GARBUTT, works_item_id: PM, clear_attention: true,
    invoices: LIVE.map((x) => ({
      afp_id: x.id, invoice_number: x.inv, works: x.works, paid_in_xero: x.paid,
      expenses: x.inv === "INV-001" ? [LAPTOP] : [],
    })),
    ...over,
  };
}

describe("planRestatement — Garbutt's real series", () => {
  test("fifteen invoices come to what he billed, split paid and owed as Xero has them", () => {
    const plan = planRestatement(request(), APPS(), LINES());
    assert.ok(plan.ok, JSON.stringify(!plan.ok && plan.errors));
    assert.equal(plan.totals.invoices, 15);
    assert.equal(plan.totals.value_before, 9346);
    assert.equal(plan.totals.value_after, 44366.58);
    assert.equal(plan.totals.paid_after, 40516.58);
    assert.equal(plan.totals.owed_after, 3850);
  });

  test("#23 goes from £6,046 to its invoice's £3,850, and loses Cladders' £2,196", () => {
    const plan = planRestatement(request(), APPS(), LINES());
    assert.ok(plan.ok);
    const s = plan.steps.find((x) => x.app_number === 23)!;
    assert.equal(s.before.value, 6046);
    assert.equal(s.after.value, 3850);
    assert.equal(s.before.other_boq.reduce((t, l) => t + l.value, 0), 2196);
    assert.equal(s.after.status, "paid");
    assert.equal(s.after.payment_reference, paymentReference("INV-013"));
    assert.equal(s.after.attention, false, "the flag clears once the figure is put right");
  });

  test("INV-015 is restated but stays owed — Xero hasn't paid it", () => {
    const plan = planRestatement(request(), APPS(), LINES());
    assert.ok(plan.ok);
    const s = plan.steps.find((x) => x.invoice_number === "INV-015")!;
    assert.equal(s.after.status, "submitted");
    assert.equal(s.after.value, 3850);
    assert.equal(s.after.certified_amount, null);
    assert.equal(s.after.payment_reference, null);
  });

  test("#3, certified at £3,300, keeps its certificate and is recorded as paid", () => {
    const plan = planRestatement(request(), APPS(), LINES());
    assert.ok(plan.ok);
    const s = plan.steps.find((x) => x.app_number === 3)!;
    assert.equal(s.after.certified_amount, 3300);
    assert.equal(s.after.status, "paid");
  });

  test("INV-001's laptop is an expense on top of three days' time", () => {
    const plan = planRestatement(request(), APPS(), LINES());
    assert.ok(plan.ok);
    const s = plan.steps.find((x) => x.invoice_number === "INV-001")!;
    assert.equal(s.after.works, 1650);
    assert.deepEqual(s.after.expenses, [LAPTOP]);
    assert.equal(s.after.value, 2016.58);
  });
});

describe("planRestatement — what it refuses", () => {
  const refuses = (req: RestateRequest, apps: RestateAppRow[], pattern: RegExp) => {
    const plan = planRestatement(req, apps, LINES());
    assert.equal(plan.ok, false);
    assert.ok(!plan.ok && plan.errors.some((e) => pattern.test(e)), !plan.ok ? plan.errors.join("\n") : "");
  };

  test("leaving an application out of the series", () => {
    const req = request();
    req.invoices = req.invoices.filter((i) => i.invoice_number !== "INV-009");
    refuses(req, APPS(), /#18 .* isn't listed/);
  });

  test("a certificate already agreed at a different value", () => {
    const apps = APPS().map((a) => (a.app_number === 3 ? { ...a, certified_amount: 5496 } : a));
    refuses(request(), apps, /already certified at £5496\.00/);
  });

  test("an application the app has billed to Xero itself", () => {
    const apps = APPS().map((a) => (a.app_number === 9 ? { ...a, xero_po_id: "abc" } : a));
    refuses(request(), apps, /already billed this to Xero/);
  });

  test("an application marked paid in the app by someone else", () => {
    const apps = APPS().map((a) => (a.app_number === 9 ? { ...a, status: "paid" } : a));
    refuses(request(), apps, /already marked paid/);
  });

  test("the same invoice twice", () => {
    const req = request();
    req.invoices[1] = { ...req.invoices[1], invoice_number: "INV-002" };
    refuses(req, APPS(), /INV-002 is listed twice/);
  });

  test("a prelims drawdown", () => {
    const apps = APPS().map((a) => (a.app_number === 9 ? { ...a, prelim_heading: "Site management", claimed_amount: 3300 } : a));
    refuses(request(), apps, /prelims drawdown/);
  });

  test("another subcontractor's application", () => {
    const apps = [...APPS(), { ...appRow(LIVE[1]), id: 999, counterparty_supplier_id: CLADDERS }];
    const req = request();
    req.invoices.push({ afp_id: 999, invoice_number: "CL-001", works: 100, paid_in_xero: true });
    refuses(req, apps, /not an incoming labour application for this subcontractor/);
  });
});

// Run the writes for real, then LABOUR_POSITION — the one query behind labour
// expended, forecast cost and the dashboard — over the result.
function database() {
  const d = new DatabaseSync(":memory:");
  d.exec(`
    CREATE TABLE material_snapshots (id INTEGER PRIMARY KEY, project_id TEXT, is_active INTEGER);
    CREATE TABLE contract_items (id INTEGER PRIMARY KEY, snapshot_id INTEGER, section TEXT, description TEXT,
      qty REAL, labour_rate REAL, labour_total REAL);
    CREATE TABLE labour_live_rates (contract_item_id INTEGER, description TEXT, project_id TEXT, status TEXT,
      live_rate REAL, applied_at TEXT);
    CREATE TABLE applications_for_payment (id INTEGER PRIMARY KEY, project_id TEXT, direction TEXT, app_number INTEGER,
      status TEXT, counterparty_supplier_id INTEGER, prelim_heading TEXT, claimed_amount REAL, claim_basis TEXT,
      unmatched_lines_json TEXT, resolved_lines_json TEXT, amount_due REAL, certified_amount REAL,
      certified_at TEXT, certified_by TEXT, submitted_at TEXT, submitted_by TEXT, paid_at TEXT, paid_by TEXT,
      payment_reference TEXT, attention_note TEXT, attention_note_by TEXT, attention_note_at TEXT);
    CREATE TABLE afp_lines (id INTEGER PRIMARY KEY AUTOINCREMENT, afp_id INTEGER, contract_item_id INTEGER, section TEXT,
      description TEXT, unit TEXT, qty REAL, rate REAL, contract_value REAL, percent_complete REAL,
      cumulative_value REAL, is_adhoc INTEGER, display_order INTEGER, variation_id INTEGER);
    CREATE TABLE audit_log (entity_type TEXT, entity_id TEXT, action TEXT, actor TEXT, details TEXT, created_at TEXT);
    INSERT INTO material_snapshots VALUES (1, '${P}', 1);
    INSERT INTO contract_items VALUES (${PM}, 1, 'Prelims', 'Project Manager Whole Scope', 19.2, 2500, 48000);
    INSERT INTO contract_items VALUES (1865, 1, 'Removal of Flashings', 'Cladding Removal of Flashings', 495, 12, 5940);
  `);
  const ins = d.prepare(`INSERT INTO applications_for_payment (id, project_id, direction, app_number, status,
    counterparty_supplier_id, claim_basis, certified_amount, attention_note) VALUES (?, ?, 'incoming_labour', ?, ?, ?, ?, ?, ?)`);
  for (const a of APPS()) ins.run(a.id, P, a.app_number, a.status, GARBUTT, null, a.certified_amount, a.attention_note);
  const insL = d.prepare(`INSERT INTO afp_lines (id, afp_id, contract_item_id, section, description, contract_value,
    percent_complete, cumulative_value, is_adhoc, display_order) VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0, ?)`);
  for (const l of LINES()) insL.run(l.id, l.afp_id, l.contract_item_id, l.section, l.description, l.contract_value, l.cumulative_value, l.display_order);
  // Cladders, certified #1 £2,196 and #2 £9,676.80 — a separate subcontractor
  // the restatement must not move.
  d.exec(`
    INSERT INTO applications_for_payment (id, project_id, direction, app_number, status, counterparty_supplier_id, certified_amount)
      VALUES (50, '${P}', 'incoming_labour', 1, 'certified', ${CLADDERS}, 2196), (51, '${P}', 'incoming_labour', 2, 'certified', ${CLADDERS}, 7480.8);
    INSERT INTO afp_lines (afp_id, contract_item_id, section, description, contract_value, percent_complete, cumulative_value, is_adhoc, display_order)
      VALUES (50, 1865, 'Removal of Flashings', 'x', 5940, 0, 2196, 0, 1), (51, 1865, 'Removal of Flashings', 'x', 5940, 0, 9676.8, 0, 1);
  `);
  return d;
}
const exec = (d: DatabaseSync, ws: Array<{ sql: string; params: unknown[] }>) => {
  for (const w of ws) d.prepare(w.sql).run(...(w.params as Array<string | number | null>));
};
/** recalcTotals, for a period claim with no retention: own lines plus own expenses. */
function recalc(d: DatabaseSync, id: number) {
  const ls = d.prepare("SELECT section, cumulative_value, is_adhoc FROM afp_lines WHERE afp_id = ?").all(id) as Array<{ section: string; cumulative_value: number; is_adhoc: number }>;
  const exp = ls.filter((l) => l.is_adhoc === 1 && /expenses/i.test(l.section)).reduce((s, l) => s + l.cumulative_value, 0);
  const dw = ls.filter((l) => l.is_adhoc === 1 && /dayworks/i.test(l.section)).reduce((s, l) => s + l.cumulative_value, 0);
  const cum = ls.filter((l) => !(l.is_adhoc === 1 && /expenses|dayworks/i.test(l.section))).reduce((s, l) => s + l.cumulative_value, 0);
  const due = Math.round(periodNet({ cumulative: cum, previousCertified: 0, expensesAmount: exp, dayworksAmount: dw, basis: "period" }) * 100) / 100;
  d.prepare("UPDATE applications_for_payment SET amount_due = ? WHERE id = ?").run(due, id);
  return due;
}
const position = (d: DatabaseSync) => d.prepare(
  `SELECT COALESCE(SUM(boq_expended), 0) AS boq, COALESCE(SUM(other_expended), 0) AS other FROM (${LABOUR_POSITION}) WHERE pid = ?`,
).get(P) as { boq: number; other: number };
const pos = (d: DatabaseSync) => ({ ...position(d) });

function applyAll(d: DatabaseSync, steps: RestateStep[]) {
  const now = "2026-10-12T17:00:00Z";
  for (const s of steps) {
    const cur = d.prepare("SELECT unmatched_lines_json, resolved_lines_json FROM applications_for_payment WHERE id = ?").get(s.afp_id) as { unmatched_lines_json: string | null; resolved_lines_json: string | null };
    exec(d, lineWrites(s, PM, "tester", now, cur));
  }
  const errors: string[] = [];
  for (const s of steps) {
    const settled = settleWrites(s, recalc(d, s.afp_id), "tester", now);
    if (settled.error) errors.push(settled.error);
    exec(d, settled.writes);
  }
  return errors;
}

describe("applying the restatement", () => {
  test("labour expended becomes what was paid; Cladders is untouched", () => {
    const d = database();
    // Before: newest certified per subcontractor — Cladders £9,676.80 plus
    // Garbutt #3's £5,496 (which includes Cladders' £2,196 a second time).
    assert.deepEqual(pos(d), { boq: 9676.8 + 5496, other: 0 });

    const plan = planRestatement(request(), APPS(), LINES());
    assert.ok(plan.ok);
    assert.deepEqual(applyAll(d, plan.steps), []);

    // After: Cladders' £9,676.80, Garbutt's fourteen paid weeks of time
    // (£40,150) and the laptop (£366.58) as an expense outside the BOQ.
    const after = pos(d);
    assert.equal(Math.round(after.boq * 100) / 100, 9676.8 + 40150);
    assert.equal(Math.round(after.other * 100) / 100, 366.58);
  });

  test("every paid invoice is paid at its own value, with a reference to the Xero bill", () => {
    const d = database();
    const plan = planRestatement(request(), APPS(), LINES());
    assert.ok(plan.ok);
    applyAll(d, plan.steps);
    const rows = d.prepare("SELECT app_number, status, certified_amount, payment_reference, claim_basis, attention_note FROM applications_for_payment WHERE counterparty_supplier_id = ? ORDER BY app_number").all(GARBUTT) as Array<{ app_number: number; status: string; certified_amount: number | null; payment_reference: string | null; claim_basis: string; attention_note: string | null }>;
    for (const x of LIVE) {
      const r = rows.find((y) => y.app_number === x.n)!;
      assert.equal(r.claim_basis, "period", `#${x.n}`);
      if (x.paid) {
        assert.equal(r.status, "paid", `#${x.n}`);
        assert.equal(r.certified_amount, x.inv === "INV-001" ? 2016.58 : x.works, `#${x.n}`);
        assert.equal(r.payment_reference, paymentReference(x.inv));
      } else {
        assert.equal(r.status, "submitted", `#${x.n}`);
        assert.equal(r.payment_reference, null);
      }
      assert.equal(r.attention_note, null, `#${x.n}`);
    }
    const audits = d.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'restated_from_invoice'").get() as { n: number };
    assert.equal(audits.n, 15);
  });

  test("Cladders' work is gone from every Garbutt line", () => {
    const d = database();
    const plan = planRestatement(request(), APPS(), LINES());
    assert.ok(plan.ok);
    applyAll(d, plan.steps);
    const stray = d.prepare(`SELECT COALESCE(SUM(l.cumulative_value), 0) AS v FROM afp_lines l
      JOIN applications_for_payment a ON a.id = l.afp_id
      WHERE a.counterparty_supplier_id = ? AND l.contract_item_id <> ?`).get(GARBUTT, PM) as { v: number };
    assert.equal(stray.v, 0);
  });

  test("running it a second time changes nothing", () => {
    const d = database();
    const first = planRestatement(request(), APPS(), LINES());
    assert.ok(first.ok);
    applyAll(d, first.steps);
    const apps = (d.prepare(`SELECT id, project_id, direction, app_number, status, counterparty_supplier_id, prelim_heading,
      claimed_amount, claim_basis, NULL AS xero_po_id, 0 AS retention_pct, 0 AS vat_pct, NULL AS cumulative_value,
      amount_due AS this_period_net, certified_amount, attention_note, unmatched_lines_json, resolved_lines_json
      FROM applications_for_payment WHERE counterparty_supplier_id = ?`).all(GARBUTT)) as unknown as RestateAppRow[];
    const lines = d.prepare(`SELECT id, afp_id, contract_item_id, section, description, contract_value, cumulative_value,
      is_adhoc, variation_id, display_order FROM afp_lines`).all() as unknown as RestateLineRow[];
    const second = planRestatement(request(), apps, lines);
    assert.ok(second.ok, !second.ok ? second.errors.join("\n") : "");
    const paidSteps = second.steps.filter((s) => s.after.status === "paid");
    assert.ok(paidSteps.every((s) => s.no_op), "paid applications are already done");
    const before = pos(d);
    applyAll(d, second.steps);
    assert.deepEqual(pos(d), before);
  });

  test("an application is never recorded as paid at a value its invoice doesn't carry", () => {
    const plan = planRestatement(request(), APPS(), LINES());
    assert.ok(plan.ok);
    const s = plan.steps[0];
    const settled = settleWrites(s, s.after.value + 1, "tester", "now");
    assert.match(settled.error ?? "", /left unpaid/);
    assert.deepEqual(settled.writes, []);
  });

  test("a draft's review tray is kept, marked as superseded, not thrown away", () => {
    const plan = planRestatement(request(), APPS(), LINES());
    assert.ok(plan.ok);
    const s = plan.steps.find((x) => x.invoice_number === "INV-001")!;
    const ws = lineWrites(s, PM, "tester", "now", {
      unmatched_lines_json: JSON.stringify([{ line_no: 2, description: "IT Equipment (Laptop, bag and mouse)", this_period_value: 366.58 }]),
      resolved_lines_json: null,
    });
    const last = ws[ws.length - 1];
    const kept = JSON.parse(String(last.params[0]));
    assert.equal(kept.length, 1);
    assert.equal(kept[0].resolution.action, "restated_from_invoice");
  });
});

// Cladders on Blyth, as the live database holds it on 13 Oct 2026. They bill
// TIME ("2 x Operatives x 10 Hours per Shift @ £33.00 P/H"), so there is no
// BOQ line the time belongs on: the reader matched #1/#2 onto flashing items
// and #15 onto the PM line, and the 10-08 repair moved the drafts' time into
// Dayworks. #2 was certified at £7,480.80 against a £9,676.80 invoice that
// Xero paid in full. #6, a second upload of Invoice 001, goes back to draft
// before the restatement and is left out.
describe("restating a time-billing subcontractor (Cladders) into Dayworks", () => {
  const CL: Array<{ id: number; n: number; status: string; net: number; cert: number | null; boq: Array<[number, number]>; dw: number; inv: string; works: number; exp?: number; paid: boolean; recert?: boolean }> = [
    { id: 39, n: 1, status: "certified", net: 2196, cert: 2196, boq: [[1865, 828], [1866, 648], [1867, 720]], dw: 0, inv: "Invoice 001", works: 2196, paid: true },
    { id: 53, n: 2, status: "certified", net: 7480.8, cert: 7480.8, boq: [[1865, 5112], [1867, 4564.8]], dw: 0, inv: "Invoice 002", works: 9676.8, paid: true, recert: true },
    { id: 60, n: 7, status: "draft", net: 5328, cert: null, boq: [], dw: 5328, inv: "Invoice 003", works: 5328, paid: true },
    { id: 76, n: 15, status: "submitted", net: 0, cert: null, boq: [[PM, 3300]], dw: 0, inv: "Invoice 006", works: 3300, paid: true },
    { id: 95, n: 26, status: "draft", net: 3357.86, cert: null, boq: [], dw: 3300, inv: "Invoice 011", works: 3300, exp: 57.86, paid: true },
    { id: 98, n: 28, status: "submitted", net: 9504, cert: null, boq: [[PM, 9900], [1865, 2484]], dw: 9504, inv: "Invoice 012", works: 9504, paid: false },
  ];
  const ITEMS = [PM, 1865, 1866, 1867];
  const clApps = (): RestateAppRow[] => CL.map((x) => ({
    id: x.id, project_id: P, direction: "incoming_labour", app_number: x.n, status: x.status,
    counterparty_supplier_id: CLADDERS, prelim_heading: null, claimed_amount: null, claim_basis: null,
    xero_po_id: null, retention_pct: 0, vat_pct: 0, cumulative_value: x.boq.reduce((t, [, v]) => t + v, 0),
    this_period_net: x.net, certified_amount: x.cert, attention_note: null,
    unmatched_lines_json: null, resolved_lines_json: null,
  }));
  const clLines = (): RestateLineRow[] => CL.flatMap((x) => {
    const out: RestateLineRow[] = ITEMS.map((ci, i) => ({
      id: x.id * 100 + i, afp_id: x.id, contract_item_id: ci, section: "BOQ", description: `item ${ci}`,
      contract_value: 5940, cumulative_value: x.boq.find(([c]) => c === ci)?.[1] ?? 0, is_adhoc: 0, variation_id: null, display_order: i,
    }));
    if (x.dw) out.push({ id: x.id * 100 + 50, afp_id: x.id, contract_item_id: null, section: "Dayworks", description: "time", contract_value: x.dw, cumulative_value: x.dw, is_adhoc: 1, variation_id: null, display_order: 50 });
    if (x.exp) out.push({ id: x.id * 100 + 51, afp_id: x.id, contract_item_id: null, section: "Expenses", description: "Expenses", contract_value: x.exp, cumulative_value: x.exp, is_adhoc: 1, variation_id: null, display_order: 51 });
    return out;
  });
  const clRequest = (over: Partial<RestateRequest> = {}): RestateRequest => ({
    project_id: P, supplier_id: CLADDERS, works_as: "dayworks",
    invoices: CL.map((x) => ({
      afp_id: x.id, invoice_number: x.inv, works: x.works, paid_in_xero: x.paid, recertify: x.recert,
      works_description: `${x.inv} — operatives' time`,
      expenses: x.exp ? [{ description: "Expenses", amount: x.exp }] : [],
    })),
    ...over,
  });
  function clDatabase() {
    const d = new DatabaseSync(":memory:");
    d.exec(`
      CREATE TABLE material_snapshots (id INTEGER PRIMARY KEY, project_id TEXT, is_active INTEGER);
      CREATE TABLE contract_items (id INTEGER PRIMARY KEY, snapshot_id INTEGER, section TEXT, description TEXT, qty REAL, labour_rate REAL, labour_total REAL);
      CREATE TABLE labour_live_rates (contract_item_id INTEGER, description TEXT, project_id TEXT, status TEXT, live_rate REAL, applied_at TEXT);
      CREATE TABLE applications_for_payment (id INTEGER PRIMARY KEY, project_id TEXT, direction TEXT, app_number INTEGER,
        status TEXT, counterparty_supplier_id INTEGER, prelim_heading TEXT, claimed_amount REAL, claim_basis TEXT,
        unmatched_lines_json TEXT, resolved_lines_json TEXT, amount_due REAL, certified_amount REAL,
        certified_at TEXT, certified_by TEXT, submitted_at TEXT, submitted_by TEXT, paid_at TEXT, paid_by TEXT,
        payment_reference TEXT, attention_note TEXT, attention_note_by TEXT, attention_note_at TEXT);
      CREATE TABLE afp_lines (id INTEGER PRIMARY KEY AUTOINCREMENT, afp_id INTEGER, contract_item_id INTEGER, section TEXT,
        description TEXT, unit TEXT, qty REAL, rate REAL, contract_value REAL, percent_complete REAL,
        cumulative_value REAL, is_adhoc INTEGER, display_order INTEGER, variation_id INTEGER);
      CREATE TABLE audit_log (entity_type TEXT, entity_id TEXT, action TEXT, actor TEXT, details TEXT, created_at TEXT);
      INSERT INTO material_snapshots VALUES (1, '${P}', 1);
    `);
    const ins = d.prepare(`INSERT INTO applications_for_payment (id, project_id, direction, app_number, status,
      counterparty_supplier_id, certified_amount, certified_at) VALUES (?, ?, 'incoming_labour', ?, ?, ?, ?, ?)`);
    for (const a of clApps()) ins.run(a.id, P, a.app_number, a.status, CLADDERS, a.certified_amount, a.certified_amount != null ? "2026-07-15" : null);
    const insL = d.prepare(`INSERT INTO afp_lines (id, afp_id, contract_item_id, section, description, contract_value,
      percent_complete, cumulative_value, is_adhoc, display_order) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`);
    for (const l of clLines()) insL.run(l.id, l.afp_id, l.contract_item_id, l.section, l.description, l.contract_value, l.cumulative_value, l.is_adhoc, l.display_order);
    return d;
  }
  function clApply(d: DatabaseSync, steps: RestateStep[]) {
    for (const s of steps) {
      const cur = d.prepare("SELECT unmatched_lines_json, resolved_lines_json FROM applications_for_payment WHERE id = ?").get(s.afp_id) as { unmatched_lines_json: string | null; resolved_lines_json: string | null };
      exec(d, lineWrites(s, null, "tester", "now", cur));
    }
    const errors: string[] = [];
    for (const s of steps) {
      const settled = settleWrites(s, recalc(d, s.afp_id), "tester", "now");
      if (settled.error) errors.push(settled.error);
      exec(d, settled.writes);
    }
    return errors;
  }

  test("each invoice is worth what it says, its time on one Dayworks line", () => {
    const plan = planRestatement(clRequest(), clApps(), clLines());
    assert.ok(plan.ok, !plan.ok ? plan.errors.join("\n") : "");
    assert.equal(plan.totals.value_after, 2196 + 9676.8 + 5328 + 3300 + 3357.86 + 9504);
    assert.equal(plan.totals.owed_after, 9504);
    for (const s of plan.steps) {
      assert.equal(s.works_line_id, null);
      assert.equal(s.works_as, "dayworks");
    }
  });

  test("#2's £7,480.80 certificate is refused without recertify, replaced with it", () => {
    const req = clRequest();
    req.invoices = req.invoices.map((i) => ({ ...i, recertify: false }));
    const refused = planRestatement(req, clApps(), clLines());
    assert.ok(!refused.ok && refused.errors.some((e) => /already certified at £7480\.80/.test(e)));

    const plan = planRestatement(clRequest(), clApps(), clLines());
    assert.ok(plan.ok);
    const s = plan.steps.find((x) => x.app_number === 2)!;
    assert.equal(s.before.certified_amount, 7480.8, "the old certificate goes in the audit row");
    assert.equal(s.after.certified_amount, 9676.8);
  });

  test("recertify is refused on an invoice Xero hasn't paid", () => {
    const req = clRequest();
    req.invoices = req.invoices.map((i) => (i.invoice_number === "Invoice 002" ? { ...i, paid_in_xero: false } : i));
    const plan = planRestatement(req, clApps(), clLines());
    assert.ok(!plan.ok && plan.errors.some((e) => /recertify is only for an invoice Xero has paid/.test(e)));
  });

  test("BOQ mode still needs a works item", () => {
    const plan = planRestatement(clRequest({ works_as: "boq" }), clApps(), clLines());
    assert.ok(!plan.ok && plan.errors.includes("works_item_id required"));
  });

  test("applied: no BOQ position left, paid time and expenses counted once each", () => {
    const d = clDatabase();
    const plan = planRestatement(clRequest(), clApps(), clLines());
    assert.ok(plan.ok);
    assert.deepEqual(clApply(d, plan.steps), []);
    const after = pos(d);
    assert.equal(after.boq, 0, "time matched onto measured items is gone");
    assert.equal(Math.round(after.other * 100) / 100, 2196 + 9676.8 + 5328 + 3300 + 3357.86);
    const dw = d.prepare("SELECT description, cumulative_value FROM afp_lines WHERE afp_id = 53 AND section = 'Dayworks'").all() as Array<{ description: string; cumulative_value: number }>;
    assert.deepEqual(dw.map((r) => ({ ...r })), [{ description: "Invoice 002 — operatives' time", cumulative_value: 9676.8 }]);
    const r = d.prepare("SELECT status, certified_amount, certified_at FROM applications_for_payment WHERE id = 53").get() as { status: string; certified_amount: number; certified_at: string };
    assert.deepEqual({ ...r }, { status: "paid", certified_amount: 9676.8, certified_at: "2026-07-15" });
    const owed = d.prepare("SELECT status, amount_due FROM applications_for_payment WHERE id = 98").get() as { status: string; amount_due: number };
    assert.deepEqual({ ...owed }, { status: "submitted", amount_due: 9504 });
  });

  test("applied twice: the second run changes nothing", () => {
    const d = clDatabase();
    const first = planRestatement(clRequest(), clApps(), clLines());
    assert.ok(first.ok);
    clApply(d, first.steps);
    const apps = (d.prepare(`SELECT id, project_id, direction, app_number, status, counterparty_supplier_id, prelim_heading,
      claimed_amount, claim_basis, NULL AS xero_po_id, 0 AS retention_pct, 0 AS vat_pct, NULL AS cumulative_value,
      amount_due AS this_period_net, certified_amount, attention_note, unmatched_lines_json, resolved_lines_json
      FROM applications_for_payment`).all()) as unknown as RestateAppRow[];
    const lines = d.prepare(`SELECT id, afp_id, contract_item_id, section, description, contract_value, cumulative_value,
      is_adhoc, variation_id, display_order FROM afp_lines`).all() as unknown as RestateLineRow[];
    const second = planRestatement(clRequest(), apps, lines);
    assert.ok(second.ok, !second.ok ? second.errors.join("\n") : "");
    const before = pos(d);
    assert.deepEqual(clApply(d, second.steps), []);
    assert.deepEqual(pos(d), before);
    const n = d.prepare("SELECT COUNT(*) AS n FROM afp_lines WHERE section = 'Dayworks'").get() as { n: number };
    assert.equal(n.n, CL.length, "one Dayworks line per application, not two");
  });
});

// Andrew Law (Asgard Projects) bills Dallas Rd site management weekly — £420 a
// day plus hotel and mileage — and the contract prices it in each block's
// Prelims, not the labour BOQ. Each block takes its share as a prelims
// drawdown. The series as Block B holds it: PGP-010 already tagged "Site
// management" by hand, PGP-019 read into Dayworks + Expenses, PGP-024 still owed.
describe("restating a site manager (Asgard) as prelims drawdowns", () => {
  const B = "26001";
  const ASGARD = 35;
  const HEADING = "Site management";
  const ROOF = 2101; // a labour BOQ line the manual create seeded at £0
  const AS: Array<{ id: number; n: number; status: string; inv: string; works: number; exp: Array<[string, number]>; paid: boolean; drawdown?: number }> = [
    { id: 50, n: 1, status: "draft", inv: "010", works: 2100, exp: [], paid: true, drawdown: 2100 },
    { id: 79, n: 2, status: "draft", inv: "019", works: 2100, exp: [["Mileage", 108.9], ["Premier Inn + meals x 4", 528]], paid: true },
    { id: 97, n: 3, status: "submitted", inv: "024", works: 2100, exp: [["Mileage", 108.9], ["Premier Inn + meals x 4", 575]], paid: false },
  ];
  const asApps = (): RestateAppRow[] => AS.map((x) => ({
    id: x.id, project_id: B, direction: "incoming_labour", app_number: x.n, status: x.status,
    counterparty_supplier_id: ASGARD, prelim_heading: x.drawdown ? HEADING : null, claimed_amount: x.drawdown ?? null,
    claim_basis: null, xero_po_id: null, retention_pct: 0, vat_pct: 0, cumulative_value: x.drawdown ?? 0,
    this_period_net: x.drawdown ?? x.works + x.exp.reduce((s, [, v]) => s + v, 0), certified_amount: null,
    attention_note: null, unmatched_lines_json: null, resolved_lines_json: null,
  }));
  const asLines = (): RestateLineRow[] => AS.flatMap((x) => {
    const out: RestateLineRow[] = [{ id: x.id * 100, afp_id: x.id, contract_item_id: ROOF, section: "Roof", description: "Flat Roof", contract_value: 5124, cumulative_value: 0, is_adhoc: 0, variation_id: null, display_order: 1 }];
    if (!x.drawdown) {
      out.push({ id: x.id * 100 + 1, afp_id: x.id, contract_item_id: null, section: "Dayworks", description: "Management on site - DALLAS ROAD", contract_value: x.works, cumulative_value: x.works, is_adhoc: 1, variation_id: null, display_order: 2 });
      x.exp.forEach(([d, v], i) => out.push({ id: x.id * 100 + 2 + i, afp_id: x.id, contract_item_id: null, section: "Expenses", description: d, contract_value: v, cumulative_value: v, is_adhoc: 1, variation_id: null, display_order: 3 + i }));
    }
    return out;
  });
  const asRequest = (over: Partial<RestateRequest> = {}): RestateRequest => ({
    project_id: B, supplier_id: ASGARD, works_as: "prelims", prelim_heading: HEADING,
    invoices: AS.map((x) => ({
      afp_id: x.id, invoice_number: x.inv, works: x.works, paid_in_xero: x.paid,
      expenses: x.exp.map(([description, amount]) => ({ description, amount })),
    })),
    ...over,
  });
  function asDatabase() {
    const d = new DatabaseSync(":memory:");
    d.exec(`
      CREATE TABLE material_snapshots (id INTEGER PRIMARY KEY, project_id TEXT, is_active INTEGER);
      CREATE TABLE contract_items (id INTEGER PRIMARY KEY, snapshot_id INTEGER, section TEXT, description TEXT, qty REAL, labour_rate REAL, labour_total REAL);
      CREATE TABLE labour_live_rates (contract_item_id INTEGER, description TEXT, project_id TEXT, status TEXT, live_rate REAL, applied_at TEXT);
      CREATE TABLE applications_for_payment (id INTEGER PRIMARY KEY, project_id TEXT, direction TEXT, app_number INTEGER,
        status TEXT, counterparty_supplier_id INTEGER, prelim_heading TEXT, claimed_amount REAL, claim_basis TEXT,
        unmatched_lines_json TEXT, resolved_lines_json TEXT, cumulative_value REAL, amount_due REAL, certified_amount REAL,
        certified_at TEXT, certified_by TEXT, submitted_at TEXT, submitted_by TEXT, paid_at TEXT, paid_by TEXT,
        payment_reference TEXT, attention_note TEXT, attention_note_by TEXT, attention_note_at TEXT);
      CREATE TABLE afp_lines (id INTEGER PRIMARY KEY AUTOINCREMENT, afp_id INTEGER, contract_item_id INTEGER, section TEXT,
        description TEXT, unit TEXT, qty REAL, rate REAL, contract_value REAL, percent_complete REAL,
        cumulative_value REAL, is_adhoc INTEGER, display_order INTEGER, variation_id INTEGER);
      CREATE TABLE audit_log (entity_type TEXT, entity_id TEXT, action TEXT, actor TEXT, details TEXT, created_at TEXT);
      INSERT INTO material_snapshots VALUES (1, '${B}', 1);
      INSERT INTO contract_items VALUES (${ROOF}, 1, 'Roof', 'Flat Roof', 166, 30.87, 5124);
    `);
    const ins = d.prepare(`INSERT INTO applications_for_payment (id, project_id, direction, app_number, status,
      counterparty_supplier_id, prelim_heading, claimed_amount) VALUES (?, ?, 'incoming_labour', ?, ?, ?, ?, ?)`);
    for (const a of asApps()) ins.run(a.id, B, a.app_number, a.status, ASGARD, a.prelim_heading, a.claimed_amount);
    const insL = d.prepare(`INSERT INTO afp_lines (id, afp_id, contract_item_id, section, description, contract_value,
      percent_complete, cumulative_value, is_adhoc, display_order) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`);
    for (const l of asLines()) insL.run(l.id, l.afp_id, l.contract_item_id, l.section, l.description, l.contract_value, l.cumulative_value, l.is_adhoc, l.display_order);
    return d;
  }
  /** recalcTotals for a drawdown: its claimed amount, plus whatever Expenses or
   *  Dayworks lines it still carries — which is why none may be left on it. */
  function drawdownRecalc(d: DatabaseSync, id: number) {
    const a = d.prepare("SELECT prelim_heading, claimed_amount FROM applications_for_payment WHERE id = ?").get(id) as { prelim_heading: string | null; claimed_amount: number | null };
    const ls = d.prepare("SELECT section, cumulative_value, is_adhoc FROM afp_lines WHERE afp_id = ?").all(id) as Array<{ section: string; cumulative_value: number; is_adhoc: number }>;
    const exp = ls.filter((l) => l.is_adhoc === 1 && /expenses/i.test(l.section)).reduce((s, l) => s + l.cumulative_value, 0);
    const dw = ls.filter((l) => l.is_adhoc === 1 && /dayworks/i.test(l.section)).reduce((s, l) => s + l.cumulative_value, 0);
    const cum = a.prelim_heading != null && a.claimed_amount != null ? a.claimed_amount
      : ls.filter((l) => !(l.is_adhoc === 1 && /expenses|dayworks/i.test(l.section))).reduce((s, l) => s + l.cumulative_value, 0);
    const due = Math.round(periodNet({ cumulative: cum, previousCertified: 0, expensesAmount: exp, dayworksAmount: dw, basis: "period" }) * 100) / 100;
    d.prepare("UPDATE applications_for_payment SET cumulative_value = ?, amount_due = ? WHERE id = ?").run(cum, due, id);
    return due;
  }
  function asApply(d: DatabaseSync, steps: RestateStep[]) {
    for (const s of steps) {
      const cur = d.prepare("SELECT unmatched_lines_json, resolved_lines_json FROM applications_for_payment WHERE id = ?").get(s.afp_id) as { unmatched_lines_json: string | null; resolved_lines_json: string | null };
      exec(d, lineWrites(s, null, "tester", "now", cur));
    }
    const errors: string[] = [];
    for (const s of steps) {
      const settled = settleWrites(s, drawdownRecalc(d, s.afp_id), "tester", "now");
      if (settled.error) errors.push(settled.error);
      exec(d, settled.writes);
    }
    return errors;
  }
  const prelimLabour = (d: DatabaseSync) =>
    (d.prepare(`SELECT COALESCE(SUM(v), 0) AS v FROM (${PRELIM_LABOUR_BY_PROJECT}) WHERE pid = ?`).get(B) as { v: number }).v;
  const labour = (d: DatabaseSync) =>
    d.prepare(`SELECT COALESCE(SUM(boq_expended), 0) AS boq, COALESCE(SUM(other_expended), 0) AS other FROM (${LABOUR_POSITION}) WHERE pid = ?`).get(B) as { boq: number; other: number };

  test("each invoice becomes a drawdown worth its time plus expenses; PGP-010's own tag is restated, not refused", () => {
    const plan = planRestatement(asRequest(), asApps(), asLines());
    assert.ok(plan.ok, !plan.ok ? plan.errors.join("\n") : "");
    assert.equal(plan.totals.value_after, 7620.8);
    assert.equal(plan.totals.paid_after, 4836.9);
    assert.equal(plan.totals.owed_after, 2783.9);
    for (const s of plan.steps) {
      assert.equal(s.works_as, "prelims");
      assert.equal(s.works_line_id, null);
      assert.equal(s.after.prelim_heading, HEADING);
    }
    assert.equal(plan.steps[0].before.works_line, 2100, "PGP-010's old claimed amount is kept in the audit row");
  });

  test("prelims mode needs a heading", () => {
    const plan = planRestatement(asRequest({ prelim_heading: "  " }), asApps(), asLines());
    assert.ok(!plan.ok && plan.errors.includes("prelim_heading required"));
  });

  test("a drawdown is still refused in Dayworks mode", () => {
    const plan = planRestatement(asRequest({ works_as: "dayworks" }), asApps(), asLines());
    assert.ok(!plan.ok && plan.errors.some((e) => /010 on #1: a prelims drawdown/.test(e)));
  });

  test("applied: the money counts once, in prelims, and none of it as labour", () => {
    const d = asDatabase();
    const plan = planRestatement(asRequest(), asApps(), asLines());
    assert.ok(plan.ok);
    assert.deepEqual(asApply(d, plan.steps), []);
    const adhoc = d.prepare("SELECT COUNT(*) AS n FROM afp_lines WHERE is_adhoc = 1").get() as { n: number };
    assert.equal(adhoc.n, 0, "no Dayworks or Expenses line is left to add on top of a claimed amount");
    assert.equal(Math.round(prelimLabour(d) * 100) / 100, 4836.9, "paid drawdowns reach the prelims pot");
    assert.deepEqual({ ...labour(d) }, { boq: 0, other: 0 });
    const r = d.prepare("SELECT status, prelim_heading, claimed_amount, amount_due, certified_amount, payment_reference FROM applications_for_payment WHERE id = 79").get();
    assert.deepEqual({ ...(r as object) }, { status: "paid", prelim_heading: HEADING, claimed_amount: 2736.9, amount_due: 2736.9, certified_amount: 2736.9, payment_reference: "Paid in Xero — 019" });
    const owed = d.prepare("SELECT status, claimed_amount, amount_due FROM applications_for_payment WHERE id = 97").get();
    assert.deepEqual({ ...(owed as object) }, { status: "submitted", claimed_amount: 2783.9, amount_due: 2783.9 });
    const audit = d.prepare("SELECT details FROM audit_log WHERE entity_id = '79'").get() as { details: string };
    assert.deepEqual(JSON.parse(audit.details).after.expenses, [{ description: "Mileage", amount: 108.9 }, { description: "Premier Inn + meals x 4", amount: 528 }]);
  });

  test("applied twice: the second run changes nothing", () => {
    const d = asDatabase();
    const first = planRestatement(asRequest(), asApps(), asLines());
    assert.ok(first.ok);
    asApply(d, first.steps);
    const apps = (d.prepare(`SELECT id, project_id, direction, app_number, status, counterparty_supplier_id, prelim_heading,
      claimed_amount, claim_basis, NULL AS xero_po_id, 0 AS retention_pct, 0 AS vat_pct, cumulative_value,
      amount_due AS this_period_net, certified_amount, attention_note, unmatched_lines_json, resolved_lines_json
      FROM applications_for_payment`).all()) as unknown as RestateAppRow[];
    const lines = d.prepare(`SELECT id, afp_id, contract_item_id, section, description, contract_value, cumulative_value,
      is_adhoc, variation_id, display_order FROM afp_lines`).all() as unknown as RestateLineRow[];
    const second = planRestatement(asRequest(), apps, lines);
    assert.ok(second.ok, !second.ok ? second.errors.join("\n") : "");
    assert.deepEqual(second.steps.filter((s) => s.after.status === "paid").map((s) => s.no_op), [true, true]);
    const before = prelimLabour(d);
    assert.deepEqual(asApply(d, second.steps), []);
    assert.equal(prelimLabour(d), before);
  });

  test("a paid application restated earlier as something else is not rewritten as a drawdown", () => {
    const apps = asApps().map((a) => (a.id === 79 ? { ...a, status: "paid", claim_basis: "period", certified_amount: 2736.9 } : a));
    const plan = planRestatement(asRequest(), apps, asLines());
    assert.ok(!plan.ok && plan.errors.some((e) => /019 on #2: already marked paid in the app/.test(e)));
  });
});
