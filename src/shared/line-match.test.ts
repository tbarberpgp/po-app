// Tests for the invoice↔PO line reconciliation.
//
//   npm test
//
// Every case here is a real invoice from the production book. The rules in
// line-match.ts were rewritten five times in one day, each time because a
// screen contradicted itself or flagged something correct, and each time the
// check was a harness run against a snapshot that no longer exists. These
// pin the decisions down so the next change has to argue with them.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  invMaterialCode, jobAmbiguity, lineQty, normText, PAYMENT_SCHEDULE_LINE_ID, poRefCore, scanLineMatch,
  SERVICE_CHARGE_LINE_ID, type InvLine, type PoLineRow,
} from "./line-match";

const poLine = (o: Partial<PoLineRow> & { id: number }): PoLineRow =>
  ({ item: "Item", qty: 1, unit_cost: 1, ...o });

/** Only the issue kinds, for asserting shape without pinning every number. */
const kinds = (inv: InvLine[], po: PoLineRow[], ctx?: Parameters<typeof scanLineMatch>[2]) =>
  scanLineMatch(inv, po, ctx).issues.map((i) => i.kind).sort();

describe("lineQty", () => {
  // The single-line bug behind everything: extraction writes `quantity`, the
  // matcher read `qty`. All 98 invoices with lines used `quantity`, so the
  // billed quantity was absent everywhere and over-billing was undetectable.
  test("reads the extraction shape", () => {
    assert.equal(lineQty({ quantity: 120 }), 120);
  });
  test("reads the older manual shape", () => {
    assert.equal(lineQty({ qty: 120 }), 120);
  });
  test("prefers qty when a row somehow carries both", () => {
    assert.equal(lineQty({ qty: 5, quantity: 120 }), 5);
  });
  test("null when neither is a number", () => {
    assert.equal(lineQty({}), null);
    assert.equal(lineQty({ quantity: null }), null);
  });
});

describe("poRefCore", () => {
  test("parses our own numbers, suffix and all", () => {
    assert.equal(poRefCore("PO-26001-0013"), "26001-0013");
    assert.equal(poRefCore("PO-26001-0013-BLOCK B"), "26001-0013");
    assert.equal(poRefCore("PO-26001-0013-C1"), "26001-0013");
  });

  // 70 of 99 refs on the book are text like this. Comparing them to a PO
  // number says nothing, so they must not resolve at all.
  for (const junk of ["TOM BARBER", "DALLAS ROAD", "SIGNED QUOTATION", "Q164563/AD28/07", "AD 23/06", "DEMO", "YWW455425370"]) {
    test(`treats ${JSON.stringify(junk)} as not one of ours`, () => {
      assert.equal(poRefCore(junk), null);
    });
  }

  // Fixfast pad our job code, so every invoice they send arrives like this.
  // Until this parsed, their entire book lost wrong-PO and cross-job detection.
  test("reads a zero-padded job code as the same order", () => {
    assert.equal(poRefCore("026003-0020"), "26003-0020");
    assert.equal(poRefCore("026003-0020"), poRefCore("PO-26003-0020"));
    assert.equal(poRefCore("026001/0014"), "26001-0014");
  });
  test("padding is admitted, extra digits are not", () => {
    // Two zeros is no longer a recognisable rendering of one number.
    assert.equal(poRefCore("0026003-0020"), null);
    assert.equal(poRefCore("1026003-0020"), null);
  });

  test("does not repair typos — PO-262002-0004 has a digit too many", () => {
    // resolvePoRef does fuzzy resolution on the detail panel. Guessing here
    // would trade precision for recall in the one place precision matters.
    assert.equal(poRefCore("PO-262002-0004"), null);
  });
  test("a bare sequence is not a PO number", () => {
    assert.equal(poRefCore("PO-0139"), null);
  });
});

describe("line linking", () => {
  test("a stored link wins", () => {
    const po = [poLine({ id: 7, item: "Something else" })];
    assert.deepEqual(kinds([{ description: "Anything", po_line_id: 7 }], po), []);
  });

  test("wording matches ignoring case and punctuation", () => {
    // The one Fixfast line that survived a PO revision: "L bar" vs "L Bar".
    const po = [poLine({ id: 1, item: "SP-PL-A-40/60/2.0/3 Aluminium L Bar 40mm x 60mm" })];
    assert.deepEqual(kinds([{ description: "SP-PL-A-40/60/2.0/3 Aluminium L bar 40mm x 60mm" }], po), []);
  });

  test("falls back to the leading product code", () => {
    const po = [poLine({ id: 1, item: "SAVBRF - Euroroof Self-Adhesive AVCL 15mx1m" })];
    assert.deepEqual(kinds([{ description: "SAVBRF Euroroof AVCL (relabelled)" }], po), []);
  });

  test("a code can't claim a line another line already took", () => {
    const po = [poLine({ id: 1, item: "M20 bolt" })];
    const issues = scanLineMatch([{ description: "M20 first" }, { description: "M20 second" }], po).issues;
    assert.deepEqual(issues.map((i) => i.kind), ["unlinked"]);
  });

  test("a learned alias links a line that wording alone would miss", () => {
    // The 73 invoice_line aliases are corrections people already made. The detail
    // panel has always consulted them; this scan didn't, so the badge could say
    // "line not on the PO" for a line the panel linked happily.
    const po = [poLine({ id: 1, item: "MS-B36 - METShield MS-B36 Bars @ 3.6m Long" })];
    const aliases = new Map([[normText("VIEO 38-525-1050 rail"), normText("MS-B36 - METShield MS-B36 Bars @ 3.6m Long")]]);
    assert.deepEqual(kinds([{ description: "VIEO 38-525-1050 rail" }], po), ["unlinked"], "without the alias it can't link");
    assert.deepEqual(
      scanLineMatch([{ description: "VIEO 38-525-1050 rail" }], po, undefined, aliases).issues,
      [], "with the alias it links, same as the detail panel",
    );
  });

  test("a stored link still beats a learned alias", () => {
    const po = [poLine({ id: 1, item: "A" }), poLine({ id: 2, item: "B" })];
    const aliases = new Map([[normText("thing"), normText("A")]]);
    const m = scanLineMatch([{ description: "thing", po_line_id: 2 }], po, undefined, aliases);
    assert.deepEqual(m.issues, []);
  });

  test("a line that links to nothing is reported", () => {
    // Alumasc carriage lines — "CARR-RF1 Carriage Out - Roofing Surcharge".
    const po = [poLine({ id: 1, item: "PUBGT-30 Alumasc BGT 30mm" })];
    assert.deepEqual(kinds([{ description: "CARR-RF1 Carriage Out - Roofing Surcharge", amount: 175 }], po), ["unlinked"]);
  });

  test("a payment-schedule row is exempt", () => {
    // Big Phillies INV-2026-001: a £22,500 container invoiced as three rows —
    // Purchase Price £22,500, Deposit Due (20%) £4,500, Balance Remaining
    // £18,000. They sum to £45,000 against an invoice net of £4,500, because
    // two of them are the same money described twice. Only the first is a thing.
    const po = [poLine({ id: 1, item: "20ft Fully Kitted Catering Container - Purchase Price", qty: 1, unit_cost: 22500 })];
    const inv: InvLine[] = [
      { description: "20ft Fully Kitted Catering Container - Purchase Price", quantity: 1, unit_price: 22500, amount: 22500, po_line_id: 1 },
      { description: "Deposit Due (20%) - payable under signed Sale and Purchase Agreement", amount: 4500, po_line_id: PAYMENT_SCHEDULE_LINE_ID },
      { description: "Balance Remaining (payable before collection or delivery)", amount: 18000, po_line_id: PAYMENT_SCHEDULE_LINE_ID },
    ];
    const m = scanLineMatch(inv, po);
    assert.equal(m.state, "matched", "the one real line reconciles; the terms are not goods");
    assert.deepEqual(m.issues, []);
    assert.equal(m.excess, 0, "an £18,000 balance row must not read as over-billing");
  });

  test("an unmarked payment schedule still reports, so it can be spotted", () => {
    const po = [poLine({ id: 1, item: "Container", qty: 1, unit_cost: 22500 })];
    const inv: InvLine[] = [
      { description: "Container", quantity: 1, unit_price: 22500, amount: 22500, po_line_id: 1 },
      { description: "Deposit Due (20%)", amount: 4500 },
    ];
    assert.deepEqual(kinds(inv, po), ["unlinked"]);
  });

  test("an explicit service charge is exempt", () => {
    const po = [poLine({ id: 1, item: "PUBGT-30 Alumasc BGT 30mm" })];
    const inv: InvLine[] = [{ description: "Line Misc Charge: 12H00 Service A", amount: 0, po_line_id: SERVICE_CHARGE_LINE_ID }];
    assert.deepEqual(kinds(inv, po), []);
  });
});

describe("over-billing", () => {
  test("more units at the agreed rate", () => {
    // Barwell 73214: 120 billed against 100 ordered at £11.12. Approved as
    // "Tom to check price difference" because the screen showed neither qty.
    const po = [poLine({ id: 1, item: "FLASHINGS 50/300/50 GALV 'Z' SECTION", qty: 100, unit_cost: 11.12 })];
    const inv: InvLine[] = [{ description: "FLASHINGS / Z SECTION", quantity: 120, unit_price: 11.12, amount: 1334.4 }];
    const [issue, ...rest] = scanLineMatch(inv, po).issues;
    assert.equal(rest.length, 0);
    assert.equal(issue.kind, "over");
    assert.equal(issue.kind === "over" && issue.why, "qty");
    assert.equal(issue.kind === "over" && Math.round(issue.excess * 100) / 100, 222.4);
  });

  test("same units at a dearer rate", () => {
    // Alumasc SAVBRF: 37 rolls both sides, £134.40 against £131.54 agreed.
    const po = [poLine({ id: 1, item: "SAVBRF - Euroroof Self-Adhesive AVCL 15mx1m", qty: 37, unit_cost: 131.54 })];
    const inv: InvLine[] = [{ description: "SAVBRF - Euroroof Self-Adhesive AVCL 15mx1m", quantity: 37, unit_price: 134.4, amount: 4972.8 }];
    const issues = scanLineMatch(inv, po).issues;
    assert.deepEqual(issues.map((i) => i.kind).sort(), ["over", "rate"]);
    const over = issues.find((i) => i.kind === "over")!;
    assert.equal(over.kind === "over" && over.why, "rate");
  });

  test("higher value on a different unit basis", () => {
    // Fixfast 1605694: 1,000 brackets at £5.27 against 600 at £4.80.
    const po = [poLine({ id: 1, item: "SP-MAX-A-80/160 Spidi Max bracket", qty: 600, unit_cost: 4.8 })];
    const inv: InvLine[] = [{ description: "SP-MAX-A-80/160 Spidi Max bracket", quantity: 1000, unit_price: 5.27, amount: 5270 }];
    const over = scanLineMatch(inv, po).issues.find((i) => i.kind === "over")!;
    assert.equal(over.kind === "over" && over.why, "value");
  });

  test("inside the 1% tolerance is not over-billing", () => {
    const po = [poLine({ id: 1, item: "Widget", qty: 100, unit_cost: 10 })];
    const inv: InvLine[] = [{ description: "Widget", quantity: 100, unit_price: 10, amount: 1005 }];
    assert.deepEqual(kinds(inv, po), []);
  });

  test("billing FEWER units than ordered is not a mismatch", () => {
    // Barwell 73219: 400m invoiced against a 500m order. A correct invoice.
    // Treating any quantity difference as a mismatch flagged 9 of these.
    const po = [poLine({ id: 1, item: "Top Hat Section by Metre", qty: 500, unit_cost: 6.72 })];
    const inv: InvLine[] = [{ description: "Top Hat Section by Metre", quantity: 400, unit_price: 6.72, amount: 2688 }];
    assert.equal(scanLineMatch(inv, po).state, "matched");
  });
});

describe("rate differences", () => {
  test("reported when the money disagrees too", () => {
    const po = [poLine({ id: 1, item: "SAVBRF", qty: 23, unit_cost: 131.54 })];
    const inv: InvLine[] = [{ description: "SAVBRF", quantity: 23, unit_price: 134.4, amount: 3091.2 }];
    assert.ok(scanLineMatch(inv, po).issues.some((i) => i.kind === "rate"));
  });

  test("NOT reported when the value agrees — the unit basis just differs", () => {
    // Fixfast 1610590. 1,500 fasteners at £0.26 against 15 boxes at £26.11:
    // £391.65 either way. This read "Unmatched · rate differs from PO" on the
    // list while its own panel said "Matched ✓, ±£0" — the contradiction that
    // forced the value-first rule.
    const po = [poLine({ id: 1, item: "DF3-SS-6.0 x 45 A2/304 Stainless halter fastener", qty: 15, unit_cost: 26.11 })];
    const inv: InvLine[] = [{ description: "DF3-SS-6.0 x 45 - A2/304 stainless halter fastener", quantity: 1500, unit_price: 0.2611, amount: 391.65 }];
    const m = scanLineMatch(inv, po);
    assert.equal(m.state, "matched");
    assert.deepEqual(m.issues, []);
  });

  test("NOT reported on a part shipment billed on a different basis", () => {
    // Fixfast 1603439: 1,400 at £0.2392 against 20 at £23.92. The value is
    // LOWER (part shipment), so the value test alone would still report it —
    // the reciprocal-ratio test is what catches this one.
    const po = [poLine({ id: 1, item: "SF-T-75 x 125 SureFast insulation tube", qty: 20, unit_cost: 23.92 })];
    const inv: InvLine[] = [{ description: "SF-T-75 x 125 SureFast insulation tube", quantity: 1400, unit_price: 0.2392, amount: 334.88 }];
    assert.equal(scanLineMatch(inv, po).state, "matched");
  });

  test("a lump sum against a measured line is not a rate difference", () => {
    // Alumasc SI556275: 1 @ £20,654.55 against 166 m² @ £124.425. Same money.
    const po = [poLine({ id: 1, item: "CTF/SCHEME/1 - Tapered Insulation Scheme", qty: 166, unit_cost: 124.425 })];
    const inv: InvLine[] = [{ description: "CTF/SCHEME/1 - Tapered Insulation Scheme", quantity: 1, unit_price: 20654.55, amount: 20654.55 }];
    assert.equal(scanLineMatch(inv, po).state, "matched");
  });
});

describe("which order is linked", () => {
  const po = [poLine({ id: 1, item: "Widget", qty: 10, unit_cost: 10 })];
  const inv: InvLine[] = [{ description: "Widget", quantity: 10, unit_price: 10, amount: 100 }];

  test("a quoted ordinary order that isn't the linked one is wrong", () => {
    // Barwell 73161 quotes PO-25008-0001, linked to PO-26001-0041.
    assert.ok(kinds(inv, po, {
      quoted_ref: "PO-25008-0001", quoted_type: "standard", quoted_project: "25008",
      po_number: "PO-26001-0041", po_project: "26001", invoice_project: "26001",
    }).includes("wrong_po"));
  });

  test("a quoted FRAMEWORK on the same job is the normal workflow", () => {
    // Alumasc SI559030 quotes PO-26001-0013-BLOCK B, a live framework on job
    // 26001, linked to PO-26001-0033, a standard order on 26001 whose lines
    // are exactly the invoice's. Correct, and it read "Wrong PO?" at 0%.
    assert.deepEqual(kinds(inv, po, {
      quoted_ref: "PO-26001-0013-BLOCK B", quoted_type: "framework", quoted_project: "26001",
      po_number: "PO-26001-0033", po_project: "26001", invoice_project: "26001",
    }), []);
  });

  test("a quoted framework on a DIFFERENT job is still wrong", () => {
    // Alumasc SI558723: framework on 26001, linked to an order on 26002.
    assert.ok(kinds(inv, po, {
      quoted_ref: "PO-26001-0013-BLOCK B", quoted_type: "framework", quoted_project: "26001",
      po_number: "PO-26002-0004-C2", po_project: "26002", invoice_project: "26001",
    }).includes("wrong_po"));
  });

  // The case that went unreported for Fixfast's whole book: they pad the job
  // code, poRefCore couldn't parse the padded form, so quoted-vs-linked never
  // ran and the row reported only a value difference.
  test("a zero-padded quoted ref is compared to the linked order", () => {
    assert.ok(kinds(inv, po, {
      quoted_ref: "026003-0020", quoted_type: "standard", quoted_project: "26003",
      po_number: "PO-26001-0030", po_project: "26001", invoice_project: "26001",
    }).includes("wrong_po"));
  });
  test("a zero-padded ref that IS the linked order raises nothing", () => {
    assert.deepEqual(kinds(inv, po, {
      quoted_ref: "026001-0030", quoted_type: "standard", quoted_project: "26001",
      po_number: "PO-26001-0030", po_project: "26001", invoice_project: "26001",
    }), []);
  });

  test("free text in the ref field raises nothing", () => {
    assert.deepEqual(kinds(inv, po, {
      quoted_ref: "TOM BARBER", po_number: "PO-26001-0042", po_project: "26001", invoice_project: "26001",
    }), []);
  });

  test("an order on another job is reported", () => {
    assert.deepEqual(kinds(inv, po, {
      po_number: "PO-26003-0016", po_project: "26003", invoice_project: "26001",
    }), ["cross_project"]);
  });

  test("PO-level issues come before the line detail", () => {
    // A price agreeing with the wrong order proves nothing, so the order's own
    // identity has to be the first thing reported.
    const over = [poLine({ id: 1, item: "Widget", qty: 10, unit_cost: 10 })];
    const billedOver: InvLine[] = [{ description: "Widget", quantity: 20, unit_price: 10, amount: 200 }];
    const issues = scanLineMatch(billedOver, over, {
      quoted_ref: "PO-25008-0001", quoted_type: "standard", quoted_project: "25008",
      po_number: "PO-26001-0041", po_project: "26001", invoice_project: "26003",
    }).issues;
    assert.deepEqual(issues.map((i) => i.kind), ["wrong_po", "cross_project", "over"]);
  });
});

describe("state and totals", () => {
  test("no issues means matched", () => {
    const po = [poLine({ id: 1, item: "Widget", qty: 10, unit_cost: 10 })];
    assert.equal(scanLineMatch([{ description: "Widget", quantity: 10, unit_price: 10, amount: 100 }], po).state, "matched");
  });

  test("excess totals only what is over, across lines", () => {
    const po = [
      poLine({ id: 1, item: "A", qty: 100, unit_cost: 10 }),
      poLine({ id: 2, item: "B", qty: 100, unit_cost: 10 }),
    ];
    const inv: InvLine[] = [
      { description: "A", quantity: 120, unit_price: 10, amount: 1200 },  // +200
      { description: "B", quantity: 80, unit_price: 10, amount: 800 },    // part invoice, not counted
    ];
    const m = scanLineMatch(inv, po);
    assert.equal(m.state, "unmatched");
    assert.equal(m.excess, 200);
  });

  test("no PO lines at all leaves every line unlinked", () => {
    const m = scanLineMatch([{ description: "A" }, { description: "B" }], []);
    assert.deepEqual(m.issues.map((i) => i.kind), ["unlinked", "unlinked"]);
  });
});

describe("normalisers", () => {
  test("normText keeps only lowercase alphanumerics", () => {
    assert.equal(normText("SP-PL-A-40/60/2.0/3 Aluminium L Bar"), "sppla4060203aluminiumlbar");
    assert.equal(normText(null), "");
  });
  test("invMaterialCode takes the leading token", () => {
    assert.equal(invMaterialCode("SAVBRF - Euroroof Self-Adhesive"), "SAVBRF");
    assert.equal(invMaterialCode("SP-MAX-A-80/160 Spidi Max"), "SPMAXA80160");
    // 80/160 and 80/185 are different products — the codes must not collide.
    assert.notEqual(invMaterialCode("SP-MAX-A-80/160 x"), invMaterialCode("SP-MAX-A-80/185 x"));
    assert.equal(invMaterialCode(""), "");
  });
});

describe("jobAmbiguity", () => {
  // Invoice 1611881: quotes an order on 26003, ships to Block B which is 26001.
  test("two readings of one invoice that disagree", () => {
    const i = jobAmbiguity("26003", "26001", "026003-0020", "PO-26003-0020");
    assert.equal(i?.kind, "ambiguous_job");
    assert.deepEqual(i, {
      kind: "ambiguous_job", ref_project: "26003", address_project: "26001",
      quoted: "026003-0020", quoted_po: "PO-26003-0020",
    });
  });

  test("agreeing readings raise nothing", () => {
    assert.equal(jobAmbiguity("26003", "26003", "026003-0020", "PO-26003-0020"), null);
  });

  // One signal and no contradiction is the ordinary case, not a problem.
  test("a single reading raises nothing", () => {
    assert.equal(jobAmbiguity("26003", null, "026003-0020", "PO-26003-0020"), null);
    assert.equal(jobAmbiguity(null, "26001", null, null), null);
    assert.equal(jobAmbiguity(null, null, null, null), null);
  });

  test("survives not knowing which order the ref names", () => {
    // MatchIssue is a union, so quoted_po has to be reached through the kind.
    const i = jobAmbiguity("26003", "26001", "026003-0020", null);
    assert.equal(i?.kind === "ambiguous_job" ? i.quoted_po : "unset", null);
  });
});
