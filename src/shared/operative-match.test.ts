import { test } from "node:test";
import assert from "node:assert/strict";
import { fold, withinEdits, matchOperatives } from "./operative-match";

// A slice of the real 26001 register — the spread of spellings is the point.
const REGISTER = [
  { name: "Andrew Law", company: "PGP", trade: "Project Manager" },
  { name: "ASSET SABITUIY", company: "LATBUILD", trade: "LABOURER" },
  { name: "Cleiton gama", company: "LPS Roofing", trade: "Felter" },
  { name: "ION SERNA", company: "Latbuild", trade: "Cladder" },
  { name: "Leandro Fernandes", company: "LPS ROOFING", trade: "ROOFER" },
  { name: "SERHII TKACHENKO", company: "LATBUILD", trade: "CLADDER" },
  { name: "WILLIAM SOUZA", company: "LATBUILD", trade: "ROOFER" },
];
const names = (q: string) => matchOperatives(REGISTER, q).map((o) => o.name);

// The lockout this answers: the card said WILLIAM, he types Willian, the old
// substring filter said "No one matches" — and with no freeform name box on
// the sign-in, that was him unable to sign in at all, every day for six weeks.
test("finds a name the register spells one letter differently", () => {
  assert.deepEqual(names("Willian"), ["WILLIAM SOUZA"]);
  assert.deepEqual(names("willian souza"), ["WILLIAM SOUZA"]);
});

// Transliterated Ukrainian names drift the same way — Serhii / Sergii / Sergiy.
test("finds a transliterated name spelled the other way", () => {
  assert.deepEqual(names("Sergii Tkachenko"), ["SERHII TKACHENKO"]);
});

// A phone keyboard set to English doesn't offer the accent, so the operative
// types the bare letters and has to still find themselves.
test("ignores accents on both sides", () => {
  assert.equal(fold("José-María"), "jose maria");
  const accented = [{ name: "José Da Silva", company: "LPS", trade: "Roofer" }];
  assert.equal(matchOperatives(accented, "jose").length, 1);
  assert.equal(matchOperatives(accented, "silva").length, 1);
});

// The register is filed first-name-first; plenty of people give their surname.
test("matches on any word, not just the start of the name", () => {
  assert.deepEqual(names("souza"), ["WILLIAM SOUZA"]);
  assert.deepEqual(names("tkachenko"), ["SERHII TKACHENKO"]);
});

test("still matches on company and trade", () => {
  assert.deepEqual(names("felter"), ["Cleiton gama"]);
  assert.equal(matchOperatives(REGISTER, "latbuild").length, 4);
});

// Every word typed has to land, or a second word would widen the list instead
// of narrowing it.
test("requires every word typed to match something", () => {
  assert.deepEqual(names("willian smith"), []);
  assert.deepEqual(names("andrew latbuild"), []);
});

// Forgiveness must not outrank precision: the person who typed their own name
// correctly should not have to scroll past someone else's near-miss.
test("ranks exact hits above forgiven spellings", () => {
  const list = [
    { name: "WILLIAM SOUZA", company: "LATBUILD", trade: "ROOFER" },
    { name: "Willian Costa", company: "LPS", trade: "Roofer" },
  ];
  assert.deepEqual(matchOperatives(list, "willian").map((o) => o.name), ["Willian Costa", "WILLIAM SOUZA"]);
});

// One edit on a short word matches far too much to be useful.
test("keeps short words strict", () => {
  assert.deepEqual(names("ion"), ["ION SERNA"]);
  assert.deepEqual(names("gam"), ["Cleiton gama"]);
});

test("an empty search returns the whole register in its own order", () => {
  assert.deepEqual(names(""), REGISTER.map((o) => o.name));
  assert.deepEqual(names("   "), REGISTER.map((o) => o.name));
});

test("withinEdits counts substitutions, insertions and deletions", () => {
  assert.ok(withinEdits("william", "willian", 1));   // substitution
  assert.ok(withinEdits("souza", "souuza", 1));      // insertion
  assert.ok(withinEdits("souza", "soza", 1));        // deletion
  assert.ok(!withinEdits("souza", "silva", 1));
  assert.ok(!withinEdits("roofer", "cladder", 2));
});
