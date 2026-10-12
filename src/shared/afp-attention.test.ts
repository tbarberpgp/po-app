import { test } from "node:test";
import assert from "node:assert/strict";
import { normaliseAttentionNote, ATTENTION_NOTE_MAX } from "./afp-attention";

test("a note is kept, trimmed", () => {
  assert.equal(
    normaliseAttentionNote("  INV 013 is £3,850 (7 × £550); the app says £6,046.  "),
    "INV 013 is £3,850 (7 × £550); the app says £6,046.",
  );
});

test("blank text clears the flag rather than raising an empty one", () => {
  assert.equal(normaliseAttentionNote(""), null);
  assert.equal(normaliseAttentionNote("   \n\t "), null);
});

test("anything that is not text clears the flag", () => {
  assert.equal(normaliseAttentionNote(null), null);
  assert.equal(normaliseAttentionNote(undefined), null);
  assert.equal(normaliseAttentionNote(6046), null);
});

test("a very long note is cut to the limit", () => {
  assert.equal(normaliseAttentionNote("x".repeat(ATTENTION_NOTE_MAX + 50))?.length, ATTENTION_NOTE_MAX);
});
