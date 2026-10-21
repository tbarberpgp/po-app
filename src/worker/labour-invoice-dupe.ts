/**
 * One subcontractor invoice = one labour application.
 *
 * Why this exists. Paul Garbutt's INV-016 went in twice on Blyth — #32 from
 * the .docx (13 Oct) and #34 from the .pdf (15 Oct) — both submitted at
 * £3,300, so "Awaiting cert." showed the week twice and both could have been
 * certified and paid. The byte-hash check (findDuplicateSourceDoc) can't see
 * that: a Word file and its PDF are different bytes.
 *
 * Identity is the subcontractor's own invoice number, within one project. Not
 * across projects: one invoice can legitimately be split over several (Asgard's
 * PGP-011 was partly Blyth, partly Dallas Rd).
 *
 * Applications read before the number was captured have none recorded, so for
 * those the stored file name stands in — "Invoice INV - 016.docx" and
 * "Invoice INV - 016.pdf" are the same stem, and the stem names the number.
 * Two recorded numbers that differ are never a duplicate, whatever the files
 * are called.
 *
 * Matching is pure; findDuplicateLabourInvoice only fetches the candidates.
 */
import type { Env } from "./env";

export type LabourInvoiceCandidate = {
  id: number;
  app_number: number;
  status: string;
  invoice_number: string | null;
  source_file_name: string | null;
};

export type LabourInvoiceDupe = LabourInvoiceCandidate & { matched_on: "invoice_number" | "file_name" };

/** "INV - 016", "inv-16", "INV016" → "INV16". Null when there's no digit — a
 *  number with no digits identifies nothing. */
export function invoiceNumberKey(raw: string | null | undefined): string | null {
  const k = squash(raw ?? "");
  return /\d/.test(k) ? k : null;
}

function squash(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]+/g, "").replace(/\d+/g, (d) => String(Number(d)));
}

function fileStem(name: string | null | undefined): string | null {
  if (!name) return null;
  const k = squash(name.replace(/\.[^.]+$/, ""));
  return /\d/.test(k) ? k : null;
}

/** Does a stored file name carry this invoice number? Digit runs must end where
 *  the number ends, so INV1 is not found in "Invoice INV 16". */
function stemMentions(stem: string, key: string): boolean {
  for (let i = stem.indexOf(key); i >= 0; i = stem.indexOf(key, i + 1)) {
    const before = stem[i - 1] ?? "";
    const after = stem[i + key.length] ?? "";
    if (/\d/.test(after)) continue;
    if (/^\d/.test(key) && /\d/.test(before)) continue;
    return true;
  }
  return false;
}

export function pickLabourInvoiceDupe(
  candidates: LabourInvoiceCandidate[],
  upload: { invoice_number: string | null; file_name: string | null },
): LabourInvoiceDupe | null {
  const key = invoiceNumberKey(upload.invoice_number);
  const stem = fileStem(upload.file_name);
  for (const c of candidates) {
    const cKey = invoiceNumberKey(c.invoice_number);
    if (key && cKey) {
      if (key === cKey) return { ...c, matched_on: "invoice_number" };
      continue;
    }
    const cStem = fileStem(c.source_file_name);
    if (stem && cStem && stem === cStem) return { ...c, matched_on: "file_name" };
    if (key && cStem && stemMentions(cStem, key)) return { ...c, matched_on: "file_name" };
    if (cKey && stem && stemMentions(stem, cKey)) return { ...c, matched_on: "file_name" };
  }
  return null;
}

export class DuplicateLabourInvoiceError extends Error {
  constructor(readonly dupe: LabourInvoiceDupe, label: string) {
    super(
      `${label} is already on this project as application #${dupe.app_number} (${dupe.status}). ` +
      `Open #${dupe.app_number} instead of uploading it again — or delete it first if it's the wrong one.`,
    );
    this.name = "DuplicateLabourInvoiceError";
  }
}

/** The same subcontractor's application for the same invoice on this project,
 *  if there is one. No subcontractor, or nothing to identify the invoice by,
 *  means no check — never a false block. */
export async function findDuplicateLabourInvoice(env: Env, args: {
  projectId: string;
  supplierId: number | null;
  invoiceNumber: string | null;
  fileName: string | null;
}): Promise<LabourInvoiceDupe | null> {
  if (args.supplierId == null) return null;
  if (!invoiceNumberKey(args.invoiceNumber) && !fileStem(args.fileName)) return null;
  const rows = (await env.DB.prepare(
    `SELECT id, app_number, status, source_file_name,
            json_extract(extracted_meta_json, '$.invoice_number') AS invoice_number
       FROM applications_for_payment
      WHERE project_id = ? AND direction = 'incoming_labour' AND counterparty_supplier_id = ?
      ORDER BY app_number`,
  ).bind(args.projectId, args.supplierId).all<LabourInvoiceCandidate>()).results;
  return pickLabourInvoiceDupe(rows, { invoice_number: args.invoiceNumber, file_name: args.fileName });
}

/** Throws DuplicateLabourInvoiceError when the invoice is already in. */
export async function assertNotDuplicateLabourInvoice(env: Env, args: {
  projectId: string;
  supplierId: number | null;
  invoiceNumber: string | null;
  fileName: string | null;
}): Promise<void> {
  const dupe = await findDuplicateLabourInvoice(env, args);
  if (!dupe) return;
  const label = args.invoiceNumber?.trim()
    ? `Invoice ${args.invoiceNumber.trim()}`
    : `"${args.fileName}"`;
  throw new DuplicateLabourInvoiceError(dupe, label);
}
