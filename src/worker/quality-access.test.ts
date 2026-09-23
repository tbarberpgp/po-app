// Tests for the client quality dashboard's sign-in helpers.
//
//   npm test
//
// The dashboard used to open for anyone holding its link. These pin down the
// pieces that now stand between the link and the data: what counts as an
// address, what a typed code is reduced to, that codes are well formed, and
// that a code is bound to the dashboard and address it was issued for.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { cleanCode, codeHash, escapeHtml, newCode, newSessionToken, normalizeEmail, codePage } from "./quality-access";

describe("normalizeEmail", () => {
  test("lower-cases and trims, so the list matches however it was typed", () => {
    assert.equal(normalizeEmail("  Client.Person@Durata.co.UK "), "client.person@durata.co.uk");
  });
  test("rejects things that aren't an address", () => {
    for (const bad of ["", "nobody", "a@b", "a b@c.com", "<x@y.com>", "x@y.com, z@w.com", null, undefined]) {
      assert.equal(normalizeEmail(bad), null, String(bad));
    }
  });
});

describe("cleanCode", () => {
  test("keeps the digits of a pasted code", () => {
    assert.equal(cleanCode(" 123 456 "), "123456");
    assert.equal(cleanCode("123-456"), "123456");
  });
  test("never yields more than six digits", () => {
    assert.equal(cleanCode("1234567890"), "123456");
  });
});

test("codes are always six digits, leading zeros kept", () => {
  for (let i = 0; i < 2000; i++) assert.match(newCode(), /^\d{6}$/);
});

test("session tokens are 64 hex chars and don't repeat", () => {
  const a = newSessionToken(), b = newSessionToken();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
});

test("a code is bound to its dashboard and address", async () => {
  const h = await codeHash("p1", "a@x.com", "123456");
  assert.equal(h, await codeHash("p1", "a@x.com", "123456"));
  assert.notEqual(h, await codeHash("p2", "a@x.com", "123456"));
  assert.notEqual(h, await codeHash("p1", "b@x.com", "123456"));
});

test("the code page escapes the typed address", () => {
  const html = codePage("26004 Blyth", "/v", "/b", `"><script>alert(1)</script>`);
  assert.ok(!html.includes("<script>alert(1)"));
  assert.ok(html.includes(escapeHtml(`"><script>`)));
});
