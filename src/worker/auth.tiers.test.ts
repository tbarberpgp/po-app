// Tests for effectiveTiers — the tiers someone can act at.
//
//   npm test
//
// A superadmin or a director can do anything any tier can. The client reads
// this list as `approver_tiers`, so it is what decides which approval queues
// and buttons a person sees; the worker routes apply the same rule
// (mayDecide in routes/pos.ts, hasDirectorAuthority here).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { effectiveTiers } from "./auth";

const ALL = ["line_manager", "commercial_manager", "director"];

describe("effectiveTiers", () => {
  test("a superadmin holds every tier, even with no approver rows", () => {
    assert.deepEqual(effectiveTiers("superadmin", []), ALL);
  });

  test("a director holds every tier, whatever their role", () => {
    assert.deepEqual(effectiveTiers("commercial", ["director"]), ALL);
  });

  test("anyone else holds just their own rows", () => {
    assert.deepEqual(effectiveTiers("admin", ["line_manager"]), ["line_manager"]);
    assert.deepEqual(effectiveTiers("pm", ["commercial_manager", "line_manager"]), ["line_manager", "commercial_manager"]);
  });

  test("no rows and not a superadmin: no tiers", () => {
    assert.deepEqual(effectiveTiers("admin", []), []);
  });
});
