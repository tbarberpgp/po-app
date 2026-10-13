// Attaching a stored document to an application that has none.
//
//   npm test
//
// The case is Cladders on Blyth: #1 (Invoice 001) was keyed in by hand with no
// file and later paid; the same PDF sits on #6, a duplicate upload of it.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { planAttachSource, type AttachSource, type AttachTarget } from "./afp-source-attach";

const BLYTH = "faa754ea";
const CLADDERS = 47;
const PDF = "labour-apps/d828fb6a-CLADDERS_LTD_copy.pdf";

const one = (over: Partial<AttachTarget> = {}): AttachTarget => ({
  id: 39, project_id: BLYTH, counterparty_supplier_id: CLADDERS, source_file_key: null, ...over,
});
const six = (over: Partial<Extract<AttachSource, { kind: "afp" }>> = {}): AttachSource => ({
  kind: "afp", id: 58, project_id: BLYTH, counterparty_supplier_id: CLADDERS,
  source_file_key: PDF, source_file_name: "CLADDERS LTD copy.pdf", source_file_type: "application/pdf",
  source_file_hash: "f274e0b0", ...over,
});

describe("planAttachSource", () => {
  test("#1 takes #6's Invoice 001 PDF, under the name given", () => {
    const p = planAttachSource(one(), six(), "Cladders Invoice 001.pdf");
    assert.ok(p.ok);
    assert.deepEqual(p.file, { key: PDF, name: "Cladders Invoice 001.pdf", type: "application/pdf", hash: "f274e0b0" });
    assert.equal(p.audit.from, "application id 58");
  });

  test("without a name it keeps the stored one", () => {
    const p = planAttachSource(one(), six(), "  ");
    assert.ok(p.ok);
    assert.equal(p.file.name, "CLADDERS LTD copy.pdf");
  });

  test("an inbound tray item of the same subcontractor is a source too", () => {
    const p = planAttachSource(one(), { ...six(), kind: "inbound", id: 5 } as AttachSource);
    assert.ok(p.ok);
    assert.equal(p.audit.from, "inbound item id 5");
  });

  const refuses = (p: ReturnType<typeof planAttachSource>, pattern: RegExp) => {
    assert.equal(p.ok, false);
    assert.match(!p.ok ? p.error : "", pattern);
  };

  test("refuses to overwrite a document already there", () => {
    refuses(planAttachSource(one({ source_file_key: "labour-apps/other.pdf" }), six()), /already has a document/);
  });
  test("refuses a source with no document", () => {
    refuses(planAttachSource(one(), six({ source_file_key: null })), /has no stored document/);
  });
  test("refuses another subcontractor's document", () => {
    refuses(planAttachSource(one(), six({ counterparty_supplier_id: 51 })), /different subcontractor/);
  });
  test("refuses when the target has no subcontractor to compare", () => {
    refuses(planAttachSource(one({ counterparty_supplier_id: null }), six()), /different subcontractor/);
  });
  test("refuses another project's application", () => {
    refuses(planAttachSource(one(), six({ project_id: "dallas" })), /different project/);
  });
  test("refuses an application's own document", () => {
    refuses(planAttachSource(one({ id: 58 }), six()), /its own document/);
  });
});
