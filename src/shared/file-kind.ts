// What kind of document an attachment is. Deliberately dependency-free: the
// browser asks this too (to decide whether a preview is possible), and pulling
// the spreadsheet parser in with it would drag SheetJS into the Accounts chunk.

const SPREADSHEET_MIME = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/vnd.oasis.opendocument.spreadsheet",
]);

/** Does this attachment look like a spreadsheet? Checked on the MIME type first,
 *  then the filename — forwarded mail often carries a generic octet-stream. */
export function isSpreadsheetFile(name: string | null | undefined, type: string | null | undefined): boolean {
  if (type && SPREADSHEET_MIME.has(type)) return true;
  return /\.(xlsx|xlsm|xls|ods)$/i.test(name ?? "");
}
