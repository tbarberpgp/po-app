// Shared logic for the operatives bulk-upload. The row shape, UK-mobile
// normalisation and the validation/classification all live here so the SAME
// rules drive both the browser's Review preview and the Worker's authoritative
// re-validation on import — they can never drift between what the user is shown
// and what actually gets written.

export type OperativeImportRow = {
  first_name: string;
  last_name: string;
  mobile: string;
  email: string;
  company: string;
  trade: string;
  emergency_contact: string;
  row: number; // 1-based source-sheet row, for error reporting
};

/** The CSV template columns, in order. */
export const OPERATIVE_IMPORT_COLUMNS = [
  "first_name", "last_name", "mobile", "email", "company", "trade", "emergency_contact",
] as const;

export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Digits-only phone for matching. Drops a leading 44 / 0 so "+44 7700 900111",
 *  "07700 900111" and "7700900111" all collapse to "7700900111". Kept identical
 *  to the Worker's sign-in matcher (which re-exports this). */
export function normalisePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  let d = phone.replace(/\D/g, "");
  if (d.startsWith("44")) d = d.slice(2);
  if (d.startsWith("0")) d = d.slice(1);
  return d || null;
}

/** A plausible UK mobile normalises to 10 digits starting with 7 (07… / +447…). */
export function isPlausibleUkMobile(raw: string | null | undefined): boolean {
  const n = normalisePhone(raw);
  return !!n && /^7\d{9}$/.test(n);
}

export function fullName(r: { first_name: string; last_name: string }): string {
  return `${(r.first_name || "").trim()} ${(r.last_name || "").trim()}`.trim();
}

export type RowStatus = "new" | "update" | "error";

export type ClassifiedRow = OperativeImportRow & {
  name: string;                    // first + last, combined
  phone_norm: string | null;
  status: RowStatus;
  result: string;                  // "New" | "Updates existing" | error reason
  field?: keyof OperativeImportRow; // which cell to highlight on an error
  match_id?: string;               // the matched existing operative (status "update")
};

export type ClassifyContext = {
  /** Lower-cased approved-supplier names. */
  companies: Set<string>;
  /** phone_norm → existing operative. */
  existingByMobile: Map<string, { id: string; name: string }>;
};

/**
 * Validate + classify every parsed row. Pure: the same call backs the browser
 * preview and the Worker import. Error precedence runs field-by-field so the
 * reported reason matches the first offending cell.
 */
export function classifyOperativeRows(rows: OperativeImportRow[], ctx: ClassifyContext): ClassifiedRow[] {
  // First pass: count normalised mobiles so we can flag every member of an
  // in-file duplicate set (not just the second occurrence).
  const counts = new Map<string, number>();
  for (const r of rows) {
    const n = normalisePhone(r.mobile);
    if (n) counts.set(n, (counts.get(n) ?? 0) + 1);
  }

  return rows.map((r) => {
    const first = (r.first_name || "").trim();
    const last = (r.last_name || "").trim();
    const mobile = (r.mobile || "").trim();
    const email = (r.email || "").trim();
    const company = (r.company || "").trim();
    const trade = (r.trade || "").trim();
    const emergency = (r.emergency_contact || "").trim();
    const name = `${first} ${last}`.trim();
    const phone_norm = normalisePhone(mobile);
    const base = { ...r, name, phone_norm };
    const err = (field: keyof OperativeImportRow, result: string): ClassifiedRow =>
      ({ ...base, status: "error", field, result });

    if (!first) return err("first_name", "No first name");
    if (!last) return err("last_name", "No last name");
    if (!mobile) return err("mobile", "No mobile");
    if (!isPlausibleUkMobile(mobile)) return err("mobile", "Invalid mobile");
    if (phone_norm && (counts.get(phone_norm) ?? 0) > 1) return err("mobile", "Duplicate mobile in file");
    if (!email) return err("email", "No email");
    if (!EMAIL_RE.test(email)) return err("email", "Invalid email");
    if (!company) return err("company", "No company");
    if (!ctx.companies.has(company.toLowerCase())) return err("company", "Unknown company");
    if (!trade) return err("trade", "No trade");
    if (!emergency) return err("emergency_contact", "No emergency contact");

    const match = phone_norm ? ctx.existingByMobile.get(phone_norm) : undefined;
    if (match) return { ...base, status: "update", result: "Updates existing", match_id: match.id };
    return { ...base, status: "new", result: "New" };
  });
}

export function summariseRows(rows: ClassifiedRow[]): { newCount: number; updateCount: number; errorCount: number } {
  let newCount = 0, updateCount = 0, errorCount = 0;
  for (const r of rows) {
    if (r.status === "new") newCount++;
    else if (r.status === "update") updateCount++;
    else errorCount++;
  }
  return { newCount, updateCount, errorCount };
}
