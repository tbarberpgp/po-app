// Which WhatsApp messages are worth reading as "it arrived" — real messages
// from the Dallas Road and Blyth groups, Nov 2026.
//
//   npm test
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ARRIVAL_SQL_LIKE, looksLikeArrivalText, withinPairWindow } from "./arrival-report";

describe("looksLikeArrivalText", () => {
  for (const t of [
    "BOC Delivery of 5 bottles of gas. 4 empties returned",
    "Rooflights arrived",
    "Andrew this was delivered Tuesday at the Barwell warehouse signed for delivered by DHL",
    "Pallet of PIR offloaded on block C",
    "received 2 pallets of membrane",
    // Worth reading — the read itself turns these away as not-arrived:
    "Not received any spray paint yet. Has anyone signed for it?",
    "You should have, a delivery of aerosol cans/a 20ml pen and tester pot",
  ]) test(`reads: ${t.slice(0, 40)}`, () => assert.equal(looksLikeArrivalText(t), true));

  for (const t of [
    "Today's cladding update: North and South roof passed off by principal contractor",
    "Project email — “26001 Re: Fixfast Acknowledgement PO-26001-0101 (715658)”: Good morning",
    "ok",
    "",
  ]) test(`skips: ${t.slice(0, 40) || "(empty)"}`, () => assert.equal(looksLikeArrivalText(t), false));
});

test("every message the wording net reads is also pulled by the SQL prefilter", () => {
  const like = (text: string, pat: string) => text.toLowerCase().includes(pat.replace(/%/g, ""));
  for (const t of [
    "BOC Delivery of 5 bottles of gas", "Rooflights arrived", "received 2 pallets", "dropped off at gate",
    "turned up at 8", "came in this morning", "collected from Toolstation", "offloaded", "unloaded", "craned to roof",
  ]) {
    assert.equal(looksLikeArrivalText(t), true, t);
    assert.ok(ARRIVAL_SQL_LIKE.some((p) => like(t, p)), `prefilter misses: ${t}`);
  }
});

test("a caption and its photo pair up to 4 hours apart — BOC's were 3½", () => {
  assert.equal(withinPairWindow("2026-11-03T12:12:00Z", "2026-11-03T15:41:00Z"), true);
  assert.equal(withinPairWindow("2026-11-03T08:00:00Z", "2026-11-03T12:30:00Z"), false);
});
