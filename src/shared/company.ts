// Company details printed on every PO PDF. Adjust here once and they update
// on every newly-generated PDF — they aren't stored per-PO, so existing PDFs
// keep whatever was current when they were generated.

export const COMPANY = {
  name: "Power Grid Projects Ltd",
  // Trading / correspondence address, printed top-right of the PO.
  trading_address_lines: [
    "14 Bobbins Way",
    "Buckingham",
    "MK18 7SA",
  ],
  // Registered office, printed in the small footer.
  registered_office: "Flat 1, 384 Caledonian Road, London, N1 1DY, United Kingdom",
  company_number: "15079988",
  vat_number: "454508096",
  default_vat_rate: 0.20, // 20% — applied to every line by default
  // Receiving account printed on outgoing applications (matches the Xero
  // invoice template).
  bank: {
    account_name: "Power Grid Projects",
    sort_code: "30-90-66",
    account_number: "26061062",
  },
};
