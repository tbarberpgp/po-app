// Thin client-side wrapper that runs the shared pricing-workbook parser in
// the browser instead of in the Cloudflare Worker. The parser itself lives
// in src/shared/parse-xlsx.ts so the worker and the browser share the same
// logic; this module just deals with reading the File into an ArrayBuffer.

import {
  readPricingWorkbook,
  parseMaterialsSheet,
  parseSummaryCostSheet,
  parseContractItems,
  type ParsedMaterial,
  type ParsedCommercialRow,
  type ParsedContractItem,
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
