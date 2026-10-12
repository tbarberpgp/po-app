// Days on site — the counting rules shared by the certify panel and route.
//
//   npm test
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { belongsTo, daysDisagree, daysLine, defaultPeriod, londonDate, normaliseParty, summariseSignins, type SigninRow } from "./signin-days";

const row = (signed_in_at: string, name: string, company: string | null = null, op?: { name: string; company: string | null }): SigninRow =>
  ({ signed_in_at, name, company, op_name: op?.name ?? null, op_company: op?.company ?? null });

describe("whose sign-in it is", () => {
  test("a company matches however its name was typed on the phone", () => {
    assert.equal(normaliseParty("CLADDERS LTD"), normaliseParty("Cladders Ltd."));
    assert.ok(belongsTo("Cladders Ltd", row("2026-10-05T07:00:00Z", "A N Other", "Cladders ltd")));
  });

  test("a sole trader is the supplier — his own name is the match (Paul Garbutt has no company on the register)", () => {
    assert.ok(belongsTo("Paul Garbutt", row("2026-10-05T07:00:00Z", "PAUL GARBUTT", null)));
  });

  test("the linked operative record counts even when the typed text doesn't", () => {
    assert.ok(belongsTo("Cladders Ltd", row("2026-10-05T07:00:00Z", "Dave", "self employed", { name: "DAVE SMITH", company: "CLADDERS LTD" })));
  });

  test("someone else's sign-in doesn't", () => {
    assert.equal(belongsTo("Paul Garbutt", row("2026-10-05T07:00:00Z", "PEDRO OSHIRO", "LATBUILD")), false);
    assert.equal(belongsTo("", row("2026-10-05T07:00:00Z", "", "")), false, "no supplier set matches nobody, not everybody");
  });
});

describe("counting days", () => {
  test("one person, twice in a day, is one day", () => {
    const s = summariseSignins([
      row("2026-10-05T06:30:00Z", "Paul Garbutt"),
      row("2026-10-05T12:30:00Z", "PAUL GARBUTT"),
      row("2026-10-06T06:30:00Z", "Paul Garbutt"),
    ], "Paul Garbutt", "2026-10-02", "2026-10-08");
    assert.equal(s.distinct_days, 2);
    assert.equal(s.person_days, 2);
  });

  test("a gang counts person-days; days outside the period don't count", () => {
    const s = summariseSignins([
      row("2026-10-05T07:00:00Z", "A", "Cladders Ltd"),
      row("2026-10-05T07:00:00Z", "B", "Cladders Ltd"),
      row("2026-10-06T07:00:00Z", "A", "Cladders Ltd"),
      row("2026-10-01T07:00:00Z", "A", "Cladders Ltd"),
    ], "Cladders Ltd", "2026-10-02", "2026-10-08");
    assert.equal(s.distinct_days, 2);
    assert.equal(s.person_days, 3);
    assert.deepEqual(s.days.map((d) => d.date), ["2026-10-05", "2026-10-06"]);
  });

  test("dates are UK dates — 23:30Z in summer is the next morning in London", () => {
    assert.equal(londonDate("2026-07-01T23:30:00Z"), "2026-07-02");
    assert.equal(londonDate("2026-12-01T23:30:00Z"), "2026-12-01");
  });
});

describe("the period", () => {
  test("runs from the day after the previous application to this one's period end", () => {
    assert.deepEqual(defaultPeriod("2026-10-08", "2026-10-01"), { from: "2026-10-02", to: "2026-10-08" });
  });
  test("with no previous application, or one ending the same day, it's the week ending on the period end", () => {
    assert.deepEqual(defaultPeriod("2026-10-08", null), { from: "2026-10-02", to: "2026-10-08" });
    assert.deepEqual(defaultPeriod("2026-10-01", "2026-10-01"), { from: "2026-09-25", to: "2026-10-01" });
  });
  test("a months-old previous application doesn't stretch it past five weeks", () => {
    assert.deepEqual(defaultPeriod("2026-10-08", "2026-06-01"), { from: "2026-09-04", to: "2026-10-08" });
  });
});

describe("what the QS reads", () => {
  test("half days are fine; anything else that differs is a mismatch", () => {
    assert.equal(daysDisagree(4.5, 4.5), false);
    assert.equal(daysDisagree(5, 4), true);
  });
  test("the line", () => {
    assert.equal(daysLine(5, 4), "Invoiced 5 days · signed in 4 days");
    assert.equal(daysLine(null, 1), "Signed in 1 day");
    assert.equal(daysLine(7, 6, 2), "Invoiced 7 person-days · signed in 6 person-days");
  });
});
