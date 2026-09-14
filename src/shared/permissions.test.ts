// Tests for role + per-user grant authorization.
//
//   npm test
//
// Grants are the half with teeth: they widen what one person may do, so the
// cases that matter are the ones where a grant must NOT widen it — the
// non-grantable escalation, and a grant list belonging to nobody. The
// backwards-compatible bare-role call is covered too, because most call sites
// still pass a role and a regression there fails open across the whole app.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  can,
  NON_GRANTABLE,
  GRANTABLE_PERMISSIONS,
  ALL_PERMISSIONS,
  PERMISSION_LABELS,
} from "./permissions";

describe("can() with a bare role", () => {
  test("the role matrix still answers", () => {
    assert.equal(can("commercial", "pos.create"), true);
    assert.equal(can("commercial", "pos.edit"), false);
  });

  test("no role is no permission", () => {
    assert.equal(can(null, "pos.create"), false);
    assert.equal(can(undefined, "masterdata.read"), false);
  });

  test("a legacy role string normalises", () => {
    // "procurement" was renamed to "commercial"; prod's users CHECK still
    // permits it, so it must keep resolving rather than falling to viewer.
    assert.equal(can("procurement" as never, "commercial.edit"), true);
  });

  test("universal permissions need only a signed-in user", () => {
    assert.equal(can("viewer", "masterdata.read"), true);
    assert.equal(can(null, "masterdata.read"), false);
  });
});

describe("can() with per-user grants", () => {
  // jtong, the worked example: a QS who needs to amend POs and run site ops,
  // neither of which `commercial` carries.
  const jtong = { role: "commercial" as const, grants: ["pos.edit", "delivery.edit"] as const };

  test("a grant adds what the role lacks", () => {
    assert.equal(can({ ...jtong, grants: [...jtong.grants] }, "pos.edit"), true);
    assert.equal(can({ ...jtong, grants: [...jtong.grants] }, "delivery.edit"), true);
  });

  test("the role's own permissions are untouched by granting", () => {
    assert.equal(can({ ...jtong, grants: [...jtong.grants] }, "commercial.edit"), true);
  });

  test("a grant adds only what it names", () => {
    assert.equal(can({ ...jtong, grants: [...jtong.grants] }, "pos.delete"), false);
    assert.equal(can({ ...jtong, grants: [...jtong.grants] }, "users.write"), false);
  });

  test("grants never subtract — an empty list leaves the role intact", () => {
    assert.equal(can({ role: "commercial", grants: [] }, "pos.create"), true);
  });

  test("a grant list with no role grants nothing", () => {
    // A deactivated or unknown user carrying stale grant rows must not be let
    // in on the strength of them alone.
    assert.equal(can({ role: null, grants: ["pos.edit"] }, "pos.edit"), false);
  });

  test("promoting superadmins can never be granted", () => {
    // The one escalation that would let a grant rewrite the model itself.
    assert.equal(can({ role: "admin", grants: ["users.promote_superadmin"] }, "users.promote_superadmin"), false);
    assert.equal(NON_GRANTABLE.has("users.promote_superadmin"), true);
  });

  test("a superadmin still promotes, by role", () => {
    assert.equal(can({ role: "superadmin", grants: [] }, "users.promote_superadmin"), true);
  });

  test("a null grant list behaves as no grants", () => {
    assert.equal(can({ role: "commercial", grants: null }, "pos.edit"), false);
  });
});

describe("the grantable list", () => {
  test("offers everything except the non-grantable", () => {
    assert.equal(GRANTABLE_PERMISSIONS.includes("users.promote_superadmin"), false);
    assert.equal(GRANTABLE_PERMISSIONS.length, ALL_PERMISSIONS.length - NON_GRANTABLE.size);
  });

  test("every permission has a label for whoever hands it out", () => {
    for (const p of ALL_PERMISSIONS) {
      assert.equal(typeof PERMISSION_LABELS[p], "string", `${p} has no label`);
      assert.ok(PERMISSION_LABELS[p].length > 0, `${p} has an empty label`);
    }
  });
});
