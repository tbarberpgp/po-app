// Taking a labour certificate back from certified to submitted.
//
// Certifying is the QS agreeing the value; until the money has moved there is
// nothing wrong with withdrawing that agreement and doing it again. What can't
// be undone from here is anything that has left the app: a bill in Xero, or a
// payment. And a running-total (cumulative) certificate that a LATER one has
// already been certified on top of is the baseline for that later one — pull it
// out and the later certificate's "previously certified" no longer adds up.

export type UncertifyCert = {
  direction: string;
  status: string;
  claim_basis?: string | null;
  xero_po_id?: string | null;
  xero_po_number?: string | null;
  xero_sync_status?: string | null;
};

/** Why this certificate can't go back to submitted, or null if it can.
 *  `laterCertified` = app numbers of the same subbie's later applications on
 *  the same project that are certified or paid. */
export function uncertifyBlock(a: UncertifyCert, laterCertified: number[]): string | null {
  if (a.direction !== "incoming_labour") return "Only labour certificates can be uncertified here.";
  if (a.status === "paid") return "This certificate has been paid, so it can't go back to submitted.";
  if (a.status !== "certified") return "Only a certified labour certificate can be uncertified.";
  if (a.xero_po_id || a.xero_sync_status === "synced") {
    return `This certificate is already in Xero${a.xero_po_number ? ` as bill ${a.xero_po_number}` : ""}, `
      + "so it can't be uncertified here — change the bill in Xero instead.";
  }
  if (a.claim_basis !== "period" && laterCertified.length > 0) {
    const nums = laterCertified.map((n) => `#${n}`).join(", ");
    return `This is a running-total certificate and ${nums} ${laterCertified.length === 1 ? "has" : "have"} been certified on top of it. `
      + "Uncertify the later one first.";
  }
  return null;
}
