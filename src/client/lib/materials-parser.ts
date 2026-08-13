// Thin client-side wrapper that runs the shared pricing-workbook parser in
// the browser instead of in the Cloudflare Worker. The parser itself lives
// in src/shared/parse-xlsx.ts so the worker and the browser share the same
// logic; this module just deals with reading the File into an ArrayBuffer.

import {
  readPricingWorkbook,
  parseMaterialsSheet,
  parseSummaryCostSheet,
  parseContractItems,
  parseLabourRates,
  parseOperatives,
  type ParsedMaterial,
  type ParsedCommercialRow,
  type ParsedContractItem,
  type LabourRateLine,
  type OperativeImportRow,
} from "../../shared/parse-xlsx";

export type ParsedPricingWorkbook = {
  materials: ParsedMaterial[];
  commercials: ParsedCommercialRow[];
  contract_items: ParsedContractItem[];
};

export async function parsePricingWorkbookClient(file: File): Promise<ParsedPricingWorkbook> {
  const buf = await file.arrayBuffer();
  const wb = readPricingWorkbook(buf);
  return {
    materials: parseMaterialsSheet(wb),
    commercials: parseSummaryCostSheet(wb),
    contract_items: parseContractItems(wb),
  };
}

/** Parse a subcontractor labour rate schedule in the browser (avoids the
 *  Worker's 10ms CPU limit on multi-MB cost workbooks). */
export async function parseLabourRatesClient(file: File): Promise<LabourRateLine[]> {
  return parseLabourRates(await file.arrayBuffer());
}

/** Parse a flat operatives spreadsheet (first/last name, mobile, email, company,
 *  trade, emergency contact) in the browser, so the Worker only ever sees rows
 *  the user already previewed. */
export async function parseOperativesClient(file: File): Promise<OperativeImportRow[]> {
  return parseOperatives(await file.arrayBuffer());
}
