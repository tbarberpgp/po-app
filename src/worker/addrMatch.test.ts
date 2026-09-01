import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { pickProjectByAddress, type AddrProject } from "./addrMatch";

/** Dallas Rd: three separate contracts at one physical address, which is what
 *  makes the block letter the only thing telling them apart. */
const dallas: AddrProject[] = [
  { id: "p1", code: "26001", name: "Dallas Rd Block B Roofing", delivery_address: "Dallas Road, Kempston, MK42 9EJ", site_group_id: "g1" },
  { id: "p2", code: "26002", name: "Dallas Rd Block C Roofing", delivery_address: "Dallas Road, Kempston, MK42 9EJ", site_group_id: "g1" },
  { id: "p3", code: "26003", name: "Dallas Rd Block D Roofing", delivery_address: "Dallas Road, Kempston, MK42 9EJ", site_group_id: "g1" },
];
const at = (addr: string) => pickProjectByAddress(addr, dallas)?.code ?? null;

describe("pickProjectByAddress — grouped sites", () => {
  // Invoice 1611881 ships to Block B. Before the block letter was read, all
  // three tied and the age tie-break returned 26003 — Block D.
  test("reads the block letter off the invoice", () => {
    assert.equal(at("Power Grid Projects Ltd, Site @ Dallas Rd Block B, Dallas Road, Kempston MK42 9EJ"), "26001");
    assert.equal(at("Site @ Dallas Rd Block C, Dallas Road, Kempston MK42 9EJ"), "26002");
    assert.equal(at("Site @ Dallas Rd Block D, Dallas Road, Kempston MK42 9EJ"), "26003");
  });

  test("abbreviations and punctuation still read", () => {
    assert.equal(at("Dallas Rd Blk B, Dallas Road, Kempston MK42 9EJ"), "26001");
    assert.equal(at("Dallas Road, Block. B, Kempston MK42 9EJ"), "26001");
  });

  // No block named = nothing new to go on, so the old behaviour must stand
  // rather than the whole site becoming unassignable.
  test("an address naming no block behaves as before", () => {
    assert.equal(at("Dallas Road, Kempston MK42 9EJ"), "26003");
  });

  test("a block nobody has assigns nothing", () => {
    assert.equal(at("Site @ Dallas Rd Block Z, Dallas Road, Kempston MK42 9EJ"), null);
  });

  test("an unrelated address still assigns nothing", () => {
    assert.equal(at("14 Bobbins Way, Buckingham, MK18 7SA"), null);
  });
});
