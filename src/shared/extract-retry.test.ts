import { test } from "node:test";
import assert from "node:assert/strict";
import { isRetryableExtractError } from "./extract-retry";

test("the 2026-10-28 refusal is retried", () => {
  assert.equal(isRetryableExtractError('403 {"error":{"type":"forbidden","message":"Request not allowed"}}'), true);
});

test("rate limits, overloads and server errors are retried", () => {
  assert.equal(isRetryableExtractError('429 {"error":{"type":"rate_limit_error"}}'), true);
  assert.equal(isRetryableExtractError('529 {"error":{"type":"overloaded_error"}}'), true);
  assert.equal(isRetryableExtractError("500 Internal server error"), true);
  assert.equal(isRetryableExtractError("Connection error."), true);
  assert.equal(isRetryableExtractError("Request timed out."), true);
});

test("a file the app can't read is not retried", () => {
  assert.equal(isRetryableExtractError("Upload the invoice as a PDF, image (JPG/PNG) or spreadsheet (XLSX)."), false);
  assert.equal(isRetryableExtractError("That spreadsheet has no readable rows."), false);
  assert.equal(isRetryableExtractError("ANTHROPIC_API_KEY not configured (needed to read invoices)"), false);
  assert.equal(isRetryableExtractError('400 {"error":{"type":"invalid_request_error"}}'), false);
});

test("no error, nothing to retry", () => {
  assert.equal(isRetryableExtractError(null), false);
  assert.equal(isRetryableExtractError(""), false);
});
