// Days on site — the site sign-in register read against a labour application.
//
// A day-rate subcontractor bills "N days × £rate". Before 2026-10 the only
// check on N was the QS's memory: Paul Garbutt's Blyth invoices were certified
// (and paid in Xero) with nothing in the app to say he was there on the days
// billed. The sign-in register already records who was on which site on which
// day, with a signature and GPS fix, so the certify panel puts the two side by
// side and asks for a note when they disagree. Flag, don't block — a day spent
// off site on the job (a supplier visit, a client meeting) is legitimate.
//
// Shared so the panel (which shows it) and the certify route (which enforces
// the note) can't count days differently.

export type SigninRow = {
  signed_in_at: string;
  name: string | null;
  company: string | null;
  /** From the linked operative record (0117), when there is one. */
  op_name?: string | null;
  op_company?: string | null;
};

export type SigninDay = { date: string; people: string[] };

export type SigninSummary = {
  from: string;
  to: string;
  days: SigninDay[];
  /** Calendar days on which anyone from the subcontractor signed in. */
  distinct_days: number;
  /** One per person per day — the figure a gang's invoice is compared with. */
  person_days: number;
  people: string[];
};

/** "Cladders Ltd", "CLADDERS LTD" and "Cladders ltd." are one company. The
 *  register's company field is free text typed on a phone, so compare on the
 *  name with case, punctuation and the legal suffix stripped. */
export function normaliseParty(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(ltd|limited|llp|plc|co|company|uk)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Whether a sign-in belongs to the subcontractor. A company signs in under its
 *  company name; a sole trader (Paul Garbutt) is the supplier, so his own NAME
 *  is the match. The linked operative record is preferred to the typed text,
 *  but either is accepted — older rows and visitors carry only the text. */
export function belongsTo(supplierName: string, r: SigninRow): boolean {
  const want = normaliseParty(supplierName);
  if (!want) return false;
  return [r.op_company, r.company, r.op_name, r.name].some((v) => normaliseParty(v) === want);
}

/** The UK calendar date of a stored UTC timestamp. A 06:30 BST sign-in is
 *  05:30Z — the same day either way in practice, but a late shift after
 *  midnight UTC in winter would otherwise land on the wrong day. */
export function londonDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The period an application covers when nobody has said otherwise: the day
 *  after the same subcontractor's previous application ended, up to this one's
 *  period end. With no earlier application — or one ending the same day, which
 *  Blyth has several of — fall back to the week ending on the period end. */
export function defaultPeriod(periodEnd: string, previousPeriodEnd: string | null): { from: string; to: string } {
  const weekBack = addDays(periodEnd, -6);
  if (previousPeriodEnd && previousPeriodEnd < periodEnd) {
    const from = addDays(previousPeriodEnd, 1);
    // A gap of months means the previous one isn't really "the last week" —
    // a missing application, not a three-month claim. Cap at five weeks.
    return { from: from < addDays(periodEnd, -34) ? addDays(periodEnd, -34) : from, to: periodEnd };
  }
  return { from: weekBack, to: periodEnd };
}

export function summariseSignins(rows: SigninRow[], supplierName: string, from: string, to: string): SigninSummary {
  const byDay = new Map<string, Set<string>>();
  const everyone = new Set<string>();
  for (const r of rows) {
    if (!belongsTo(supplierName, r)) continue;
    const date = londonDate(r.signed_in_at);
    if (date < from || date > to) continue;
    const who = (r.op_name ?? r.name ?? "").trim() || "(no name)";
    // Same person twice in a day (signed out for lunch, back in) is one day.
    const key = who.toUpperCase();
    if (!byDay.has(date)) byDay.set(date, new Set());
    const set = byDay.get(date)!;
    if (![...set].some((p) => p.toUpperCase() === key)) set.add(who);
    everyone.add(who);
  }
  const days = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, people]) => ({ date, people: [...people].sort() }));
  return {
    from, to, days,
    distinct_days: days.length,
    person_days: days.reduce((n, d) => n + d.people.length, 0),
    people: [...everyone].sort(),
  };
}

/** Days are whole or half. Anything else that differs is a mismatch. */
export function daysDisagree(invoicedDays: number, signedIn: number): boolean {
  return Math.abs(invoicedDays - signedIn) >= 0.01;
}

/** "Invoiced 5 days · signed in 4 days" — the line the QS and the approver read. */
export function daysLine(invoicedDays: number | null, signedIn: number, people = 1): string {
  const d = (n: number) => `${n % 1 === 0 ? n : n.toFixed(1)} ${people > 1 ? "person-day" : "day"}${n === 1 ? "" : "s"}`;
  const signed = `signed in ${d(signedIn)}`;
  return invoicedDays == null ? signed.charAt(0).toUpperCase() + signed.slice(1) : `Invoiced ${d(invoicedDays)} · ${signed}`;
}
