// Client-side wrapper that runs the shared programme parser in the browser
// (same pattern as materials-parser.ts) so the xlsx bytes never reach the
// Worker.

import {
  readProgrammeWorkbook,
  parseProgrammeSheet,
  type ParsedProgrammeActivity,
} from "../../shared/parse-programme";

export async function parseProgrammeClient(file: File): Promise<ParsedProgrammeActivity[]> {
  const buf = await file.arrayBuffer();
  const wb = readProgrammeWorkbook(buf);
  return parseProgrammeSheet(wb);
}
