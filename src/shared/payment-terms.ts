// Shared UK trade payment-terms options — used for supplier accounts and the
// project's client terms so both stay consistent (and parseable by the cash
// models). Anything stored outside this list is preserved by prepending it as
// a one-off "(custom)" option in the dropdowns.
export const PAYMENT_TERMS_OPTIONS = [
  "Pro forma",
  "COD",
  "Net 7 days",
  "Net 14 days",
  "Net 21 days",
  "Net 30 days",
  "Net 30 days EOM",
  "Net 45 days",
  "Net 60 days",
  "Net 60 days EOM",
  "Net 75 days",
  "Net 90 days",
  "2/10 Net 30",
];

/** How often a project applies for payment. */
export const APPLICATION_CADENCES = [
  { value: "weekly", label: "Weekly" },
  { value: "biweekly", label: "Bi-weekly" },
  { value: "monthly", label: "Monthly" },
] as const;

/** CIS deduction rates for labour subcontractors, per the subbie's HMRC
 *  verification status. Deducted from the labour element only — expenses and
 *  materials sit outside CIS. null = not a CIS subcontractor. */
export const CIS_RATES = [
  { value: null, label: "Not applicable (no CIS)" },
  { value: 0, label: "0% — gross payment status" },
  { value: 20, label: "20% — registered / verified" },
  { value: 30, label: "30% — unverified" },
] as const;

/** Short label for a stored CIS rate — used on lists and the bill preview. */
export function cisRateLabel(rate: number | null | undefined): string {
  if (rate == null) return "No CIS";
  if (rate === 0) return "CIS 0% (gross)";
  return `CIS ${rate}%`;
}
