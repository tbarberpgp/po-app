import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { attachSpend, indexSpend } from "./project-forecast";
import type { MaterialWithCommitment } from "../shared/types";

/** A budget line on project p1, with only the fields the spend join reads. */
const mat = (o: Partial<MaterialWithCommitment> & { item: string }) =>
  ({ pid: "p1", cost: 10, total_units: 100, committed_qty: 0, ...o }) as MaterialWithCommitment & { pid: string };
const ix = (o: {
  committed?: Array<{ pid?: string; item: string; qty: number }>;
  coded?: Array<{ pid?: string; item: string; po_item: string; value: number }>;
  live?: Array<{ pid?: string; item: string; unit_price: number }>;
}) => indexSpend(
  (o.committed ?? []).map((r) => ({ pid: "p1", ...r })),
  (o.coded ?? []).map((r) => ({ pid: "p1", ...r })),
  (o.live ?? []).map((r) => ({ pid: "p1", ...r })),
);

describe("committed spend on a budget line", () => {
  test("counts what was ordered under the line's own wording", () => {
    const m = attachSpend(mat({ item: "Butyl Tape" }), ix({ committed: [{ item: "butyl tape", qty: 40 }] }));
    assert.equal(m.committed_qty, 40);
  });

  test("wording is matched regardless of case", () => {
    const m = attachSpend(mat({ item: "BUTYL Tape" }), ix({ committed: [{ item: "butyl tape", qty: 40 }] }));
    assert.equal(m.committed_qty, 40);
  });

  // Orders for a replaced material are raised under the replacement's name.
  test("a substituted line also counts orders under the replacement's wording", () => {
    const m = attachSpend(
      mat({ item: "Butyl Tape", sub_id: 1, sub_item: "Sealant Tape", sub_cost: 12 }),
      ix({ committed: [{ item: "butyl tape", qty: 10 }, { item: "sealant tape", qty: 30 }] }),
    );
    assert.equal(m.committed_qty, 40);
  });

  test("a line whose substitution keeps the same wording isn't counted twice", () => {
    const m = attachSpend(
      mat({ item: "Butyl Tape", sub_id: 1, sub_item: "Butyl Tape", sub_cost: 12 }),
      ix({ committed: [{ item: "butyl tape", qty: 25 }] }),
    );
    assert.equal(m.committed_qty, 25);
  });

  test("another project's orders stay on that project", () => {
    const m = attachSpend(mat({ item: "Butyl Tape" }), ix({ committed: [{ pid: "p2", item: "butyl tape", qty: 99 }] }));
    assert.equal(m.committed_qty, 0);
  });
});

describe("money coded to a budget line", () => {
  // The whole drift: the dashboard booked this £500 as unexpected spend in full;
  // the project page turns it into the quantity it buys at the line's rate.
  test("becomes quantity at the line's buy rate", () => {
    const m = attachSpend(mat({ item: "Butyl Tape", cost: 10 }),
      ix({ coded: [{ item: "butyl tape", po_item: "carriage", value: 500 }] }));
    assert.equal(m.committed_qty, 50);
  });

  test("is valued at the quoted rate when one has been applied", () => {
    const m = attachSpend(mat({ item: "Butyl Tape", cost: 10 }),
      ix({ coded: [{ item: "butyl tape", po_item: "carriage", value: 500 }], live: [{ item: "butyl tape", unit_price: 8 }] }));
    assert.equal(m.committed_qty, 62.5);
  });

  test("a coded line under the line's OWN wording isn't added again", () => {
    const m = attachSpend(mat({ item: "Butyl Tape", cost: 10 }),
      ix({ committed: [{ item: "butyl tape", qty: 40 }], coded: [{ item: "butyl tape", po_item: "butyl tape", value: 500 }] }));
    assert.equal(m.committed_qty, 40, "already counted by wording");
  });

  test("a coded line under the SUBSTITUTION's wording isn't added again", () => {
    const m = attachSpend(
      mat({ item: "Butyl Tape", cost: 10, sub_id: 1, sub_item: "Sealant Tape", sub_cost: 10 }),
      ix({ committed: [{ item: "sealant tape", qty: 30 }], coded: [{ item: "butyl tape", po_item: "sealant tape", value: 500 }] }),
    );
    assert.equal(m.committed_qty, 30);
  });

  test("several coded orders add up", () => {
    const m = attachSpend(mat({ item: "Butyl Tape", cost: 10 }), ix({
      coded: [{ item: "butyl tape", po_item: "carriage", value: 300 }, { item: "butyl tape", po_item: "delivery", value: 200 }],
    }));
    assert.equal(m.committed_qty, 50);
  });

  test("a line with no rate to value it at takes no coded quantity", () => {
    const m = attachSpend(mat({ item: "Butyl Tape", cost: 0 }),
      ix({ coded: [{ item: "butyl tape", po_item: "carriage", value: 500 }] }));
    assert.equal(m.committed_qty, 0);
  });
});

describe("the applied quote price", () => {
  test("is the newest one", () => {
    const m = attachSpend(mat({ item: "Butyl Tape", cost: 10 }),
      ix({ live: [{ item: "butyl tape", unit_price: 9 }, { item: "butyl tape", unit_price: 7 }] }));
    assert.equal(m.live_unit_price, 9);
  });

  // A rate more than 5× the BOQ cost is in the wrong basis (a pack price against
  // a per-unit line). The route falls through to the next rate that isn't.
  test("skips a rate in the wrong basis and takes the next that isn't", () => {
    const m = attachSpend(mat({ item: "Butyl Tape", cost: 10 }),
      ix({ live: [{ item: "butyl tape", unit_price: 300 }, { item: "butyl tape", unit_price: 9 }] }));
    assert.equal(m.live_unit_price, 9);
  });

  test("is null when every applied rate is in the wrong basis", () => {
    const m = attachSpend(mat({ item: "Butyl Tape", cost: 10 }), ix({ live: [{ item: "butyl tape", unit_price: 300 }] }));
    assert.equal(m.live_unit_price, null);
  });

  test("a line with no BOQ cost accepts the quote as given", () => {
    const m = attachSpend(mat({ item: "Butyl Tape", cost: null }), ix({ live: [{ item: "butyl tape", unit_price: 300 }] }));
    assert.equal(m.live_unit_price, 300);
  });
});
