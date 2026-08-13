// Structured RAMS document model. A RAMS is parsed (from .docx) into an ordered
// array of sections, each holding typed content blocks, so the operative reader
// can render 100% of the document — every section + appendix, in document order
// — on a phone. The count is data-driven: never assume a fixed number of
// sections. Anything the parser can't confidently classify still renders (as
// generic paragraph/table/image blocks) so nothing is ever dropped.

/** L (likelihood) × S (severity) → rating, as read from a risk register. */
export type RiskScore = {
  likelihood: number | null;
  severity: number | null;
  rating: number | null;
};

/** One hazard row from the landscape risk register → rendered as a card. */
export type RiskRow = {
  ref: string;
  hazard: string;
  who: string;
  initial: RiskScore | null;
  controls: string[];
  residual: RiskScore | null;
};

export type RamsBlock =
  | { type: "paragraph"; text: string; bold?: boolean }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "keyvalue"; rows: Array<{ label: string; value: string }> }
  | { type: "riskRegister"; rows: RiskRow[] }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "image"; src: string; alt?: string; w?: number; h?: number }  // src: media key (rewritten to a served URL on upload); w/h: natural px (so the reader never upscales)
  | { type: "callout"; text: string }                  // warnings / important notes
  | { type: "rawPage"; blocks: RamsBlock[] };          // fallback: un-classified content, still rendered generically

export type RamsSection = {
  id: string;                 // stable slug, e.g. "s3-responsibilities"
  /** "1", "2", "A"… for display; null for unnumbered front-matter. */
  number: string | null;
  title: string;
  blocks: RamsBlock[];
};

export type RamsDoc = {
  title: string;
  sections: RamsSection[];
};

/** Parse result: the structured doc + any embedded images (media key → bytes)
 *  to be uploaded to R2; the stored doc's image.src is then the served URL. */
export type ParsedRams = {
  doc: RamsDoc;
  media: Record<string, Uint8Array>;
};
