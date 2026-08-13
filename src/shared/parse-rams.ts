// Parse a RAMS .docx into the structured RamsDoc model (see rams.ts). Runs in
// the browser at upload time (and in Node for tests) — no DOM needed.
//
// A .docx is a zip; we read word/document.xml and walk its body children in
// DOCUMENT ORDER (paragraphs + tables interleaved). PGP's RAMS template uses no
// Word heading styles, so sections split on bold "N. Title" headings, "Appendix
// X – …", or known front-matter headings; "N.N" stays an inline sub-heading.
// Tables are classified into keyvalue / riskRegister / generic table. Images are
// pulled from word/media and returned for R2 upload. Anything we can't classify
// still renders (generic blocks) so nothing is dropped.

import { unzipSync } from "fflate";
import { XMLParser } from "fast-xml-parser";
import type { ParsedRams, RamsBlock, RamsSection, RiskRow, RiskScore } from "./rams";

// fast-xml-parser preserveOrder node: { "<tag>": ChildNode[], ":@"?: attrs } | { "#text": string }
type XNode = Record<string, unknown>;

const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: "", trimValues: false });
const decode = (b: Uint8Array) => new TextDecoder("utf-8").decode(b);

function tagOf(n: XNode): string {
  for (const k of Object.keys(n)) if (k !== ":@") return k;
  return "";
}
/** The node's own ordered children array (the value under its tag). */
function childrenOf(n: XNode): XNode[] {
  const v = n[tagOf(n)];
  return Array.isArray(v) ? (v as XNode[]) : [];
}
/** Direct children of `n` that have the given tag. */
function kids(n: XNode, tag: string): XNode[] {
  return childrenOf(n).filter((c) => tagOf(c) === tag);
}
function attr(n: XNode, name: string): string | undefined {
  return (n[":@"] as Record<string, string> | undefined)?.[name];
}
/** Depth-first collect of every descendant (and self) with the given tag. */
function findAll(nodes: XNode[], tag: string, out: XNode[] = []): XNode[] {
  for (const n of nodes) {
    if (tagOf(n) === tag) out.push(n);
    findAll(childrenOf(n), tag, out);
  }
  return out;
}

function runText(r: XNode): string {
  let s = "";
  for (const c of childrenOf(r)) {
    const t = tagOf(c);
    if (t === "w:t") for (const tn of childrenOf(c)) { if (typeof tn["#text"] === "string") s += tn["#text"] as string; }
    else if (t === "w:tab") s += " ";
    else if (t === "w:br" || t === "w:cr") s += "\n";
  }
  return s;
}
/** Full visible text of a paragraph (runs incl. those nested in hyperlinks). */
function paraText(p: XNode): string {
  return findAll([p], "w:r").map(runText).join("").replace(/ /g, " ").replace(/[ \t]+/g, " ").trim();
}
function paraIsBold(p: XNode): boolean {
  const runs = findAll([p], "w:r").filter((r) => runText(r).trim());
  if (!runs.length) return false;
  for (const r of runs) {
    const rpr = kids(r, "w:rPr")[0];
    const b = rpr ? kids(rpr, "w:b")[0] : undefined;
    const on = b && attr(b, "w:val") !== "0" && attr(b, "w:val") !== "false";
    if (!on) return false; // every visible run must be bold for a heading
  }
  return true;
}
function paraStyle(p: XNode): string | undefined {
  const ppr = kids(p, "w:pPr")[0];
  const ps = ppr ? kids(ppr, "w:pStyle")[0] : undefined;
  return ps ? attr(ps, "w:val") : undefined;
}
function paraNumId(p: XNode): string | undefined {
  const ppr = kids(p, "w:pPr")[0];
  const np = ppr ? kids(ppr, "w:numPr")[0] : undefined;
  if (!np) return undefined;
  const id = kids(np, "w:numId")[0];
  return id ? attr(id, "w:val") ?? "x" : "x";
}
function cellText(tc: XNode): string {
  return kids(tc, "w:p").map(paraText).filter(Boolean).join("\n").trim();
}
function tableMatrix(tbl: XNode): string[][] {
  return kids(tbl, "w:tr").map((tr) => kids(tr, "w:tc").map(cellText));
}

// ── numbering.xml → ordered (decimal/letter) vs unordered (bullet) ──────────
function buildNumFmtMap(zip: Record<string, Uint8Array>): Map<string, boolean> {
  const map = new Map<string, boolean>();
  const raw = zip["word/numbering.xml"];
  if (!raw) return map;
  try {
    const root = parser.parse(decode(raw)) as XNode[];
    const abstractFmt = new Map<string, boolean>();
    for (const an of findAll(root, "w:abstractNum")) {
      const aid = attr(an, "w:abstractNumId");
      const lvl = kids(an, "w:lvl").find((l) => attr(l, "w:ilvl") === "0") ?? kids(an, "w:lvl")[0];
      const fmt = lvl ? attr(kids(lvl, "w:numFmt")[0] ?? {}, "w:val") : undefined;
      if (aid != null) abstractFmt.set(aid, !!fmt && fmt !== "bullet" && fmt !== "none");
    }
    for (const num of findAll(root, "w:num")) {
      const numId = attr(num, "w:numId");
      const aid = attr(kids(num, "w:abstractNumId")[0] ?? {}, "w:val");
      if (numId != null) map.set(numId, aid != null ? abstractFmt.get(aid) ?? false : false);
    }
  } catch { /* default unordered */ }
  return map;
}

// ── Risk register ──────────────────────────────────────────────────────────
function parseScore(text: string): RiskScore | null {
  const nums = (text.match(/\d+/g) ?? []).map(Number);
  if (nums.length >= 3) return { likelihood: nums[0], severity: nums[1], rating: nums[2] };
  if (nums.length === 2) return { likelihood: nums[0], severity: nums[1], rating: nums[0] * nums[1] };
  if (nums.length === 1) return { likelihood: null, severity: null, rating: nums[0] };
  return null;
}
function isRiskRegister(headers: string[]): boolean {
  const h = headers.join(" ").toLowerCase();
  return h.includes("hazard") && /control|residual|likelihood|severity|risk/.test(h);
}
// The PGP risk register has a merged 2-row header (Initial/Residual each split
// into L|S|Rating sub-columns), so data rows are ragged: [ref, hazard, who,
// L,S,R (initial), controls, L,S,R (residual)]. Rather than trust the merged
// header indices, map per row: cols 0-2 are ref/hazard/who; the widest text cell
// from col 3 on is the Control Measures column; the numeric cells before it are
// the initial score, those after it the residual. Works for both the split
// layout and a simpler [ref,hazard,who,initial,controls,residual] one.
function toRiskRows(matrix: string[][]): RiskRow[] {
  const rows: RiskRow[] = [];
  for (let r = 1; r < matrix.length; r++) {
    const row = matrix[r];
    const hazard = (row[1] ?? "").trim();
    if (!hazard || /^hazard$/i.test(hazard)) continue;                    // header / sub-header / blank
    let ci = -1, best = -1;
    for (let c = 3; c < row.length; c++) { const len = (row[c] ?? "").length; if (len > best) { best = len; ci = c; } }
    const controls = (ci >= 0 ? row[ci] : "").split(/\n|·|•|;/).map((s) => s.trim()).filter(Boolean);
    rows.push({
      ref: (row[0] ?? "").trim() || String(rows.length + 1),
      hazard,
      who: (row[2] ?? "").trim(),
      initial: parseScore(ci > 3 ? row.slice(3, ci).join(" ") : ""),
      controls,
      residual: parseScore(ci >= 0 ? row.slice(ci + 1).join(" ") : ""),
    });
  }
  return rows;
}

// ── Heading detection ──────────────────────────────────────────────────────
const FRONT_MATTER = ["document control", "revision history", "contents", "table of contents"];
type Heading = { number: string | null; kind: "numbered" | "appendix" | "front" };
function headingInfo(text: string, bold: boolean, bareBold = false): Heading | null {
  const t = text.trim();
  if (!t || t.length > 90 || !bold) return null;
  const appx = t.match(/^Appendix\s+([A-Z0-9]+)\b/i);   // "Appendix A – …"
  if (appx) return { number: appx[1].toUpperCase(), kind: "appendix" };
  const top = t.match(/^(\d+)\.\s+\S/);                 // "1. Introduction" (not "1.1")
  if (top) return { number: top[1], kind: "numbered" };
  if (FRONT_MATTER.includes(t.toLowerCase())) return { number: null, kind: "front" };
  // Toolbox talks head their sections with bare bold labels ("Purpose", "Key
  // hazards", "PPE required") rather than RAMS-style "1. …" numbering. Those
  // docs ALSO bold whole content sentences as lead-ins, so a plain "bold =
  // heading" rule shreds a talk into dozens of fake sections. A heading is a
  // LABEL, not a sentence: short, unpunctuated, and free of the em/en dash
  // these templates use to join a lead-in to its explanation.
  if (bareBold && t.length <= 60 && !/[.?!:;,]$/.test(t) && !/[—–]/.test(t)) {
    return { number: null, kind: "front" };
  }
  return null;
}
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "section";
}
const WARN_RE = /^(warning|caution|danger|important|do not|never|must not)\b/i;

// Inline images at or below this size (px) are decorative — checkbox ticks,
// bullets, inline glyphs — and are dropped (they carry no information in a
// read-through and otherwise render as huge blurry images). See image handling.
const DECORATIVE_PX = 40;

// Checkbox glyphs used as item separators in PPE lists: ballot box ☐ ☑ ☒ and
// white square □. (Some templates use a tick image, some these characters.)
const BOX_RE = /[☐-☒□]/g;

/** Split a paragraph into the text segments delimited by inline tick images OR
 *  checkbox glyphs, in document order. PPE sections list each item after a small
 *  tick ("✓ Helmet  ✓ Hi-vis" or "Helmet ☐ Hi-vis ☐"); this recovers the items. */
function inlineChecklist(p: XNode): string[] {
  const segs: string[] = [];
  let cur = "";
  const flush = () => {
    for (const piece of cur.split(BOX_RE)) {        // a run may hold several box-delimited items
      const s = piece.replace(/ /g, " ").replace(/[ \t]+/g, " ").trim();
      if (s) segs.push(s);
    }
    cur = "";
  };
  const walk = (node: XNode) => {
    for (const c of childrenOf(node)) {
      const t = tagOf(c);
      if (t === "w:t") { for (const tn of childrenOf(c)) if (typeof tn["#text"] === "string") cur += tn["#text"] as string; }
      else if (t === "w:tab" || t === "w:br" || t === "w:cr") cur += " ";
      else if (t === "w:drawing" || t === "w:pict") flush();   // image marks an item boundary
      else walk(c);
    }
  };
  walk(p);
  flush();
  return segs;
}

/** `bareBoldHeadings` — opt-in for toolbox talks, whose sections are headed by
 *  bare bold labels instead of RAMS "1. …" numbering. Off by default so RAMS
 *  parsing is untouched. */
export function parseRamsDocx(bytes: Uint8Array, opts?: { bareBoldHeadings?: boolean }): ParsedRams {
  const zip = unzipSync(bytes);
  const docXml = zip["word/document.xml"];
  if (!docXml) throw new Error("Not a Word .docx (no word/document.xml).");
  const numFmt = buildNumFmtMap(zip);

  // Image relationships: rId → zip path under word/media.
  const relMap = new Map<string, string>();
  const relsRaw = zip["word/_rels/document.xml.rels"];
  if (relsRaw) {
    for (const rel of findAll(parser.parse(decode(relsRaw)) as XNode[], "Relationship")) {
      const id = attr(rel, "Id"); const target = attr(rel, "Target");
      if (id && target && /media\//.test(target)) {
        const path = target.replace(/^(\.\.?\/)+/, "").replace(/^\/?/, "");
        relMap.set(id, path.startsWith("word/") ? path : `word/${path}`);
      }
    }
  }

  const root = parser.parse(decode(docXml)) as XNode[];
  const body = findAll(root, "w:body")[0];
  const bodyKids = body ? childrenOf(body) : [];

  const media: Record<string, Uint8Array> = {};
  const sections: RamsSection[] = [];
  let current: RamsSection = { id: "overview", number: null, title: "Overview", blocks: [] };
  let started = false;
  let inAppendix = false; // once inside an appendix, its internal "N." headings are sub-headings, not new sections
  let pendingList: { ordered: boolean; items: string[] } | null = null;

  const flushList = () => {
    if (pendingList?.items.length) current.blocks.push({ type: "list", ordered: pendingList.ordered, items: pendingList.items });
    pendingList = null;
  };
  const pushBlock = (b: RamsBlock) => { flushList(); current.blocks.push(b); };
  const startSection = (number: string | null, title: string) => {
    flushList();
    if (started || current.blocks.length) sections.push(current);
    started = true;
    current = { id: slug(title), number, title, blocks: [] };
  };

  for (const el of bodyKids) {
    const t = tagOf(el);
    if (t === "w:tbl") {
      const matrix = tableMatrix(el).filter((r) => r.some((c) => c));
      if (!matrix.length) continue;
      const headers = matrix[0];
      if (isRiskRegister(headers)) {
        const rows = toRiskRows(matrix);
        if (rows.length) pushBlock({ type: "riskRegister", rows });
        else pushBlock({ type: "table", headers, rows: matrix.slice(1) });
      } else if (headers.length === 2) {
        pushBlock({ type: "keyvalue", rows: matrix.map((r) => ({ label: (r[0] ?? "").trim(), value: (r[1] ?? "").trim() })).filter((r) => r.label || r.value) });
      } else {
        pushBlock({ type: "table", headers, rows: matrix.slice(1) });
      }
      continue;
    }
    if (t !== "w:p") continue;

    // Inline images. Each <w:drawing> carries its display size in <wp:extent>
    // (EMU; 9525 EMU = 1px @96dpi). Tiny marks are decorative (ticks/bullets) and
    // dropped; real images keep their natural pixel size so the reader never
    // upscales (and stays sharp).
    const draws = findAll([el], "w:drawing").map((d) => {
      const blip = findAll([d], "a:blip")[0];
      const rid = blip ? attr(blip, "r:embed") ?? attr(blip, "r:link") : undefined;
      const file = rid ? relMap.get(rid) : undefined;
      const ext = findAll([d], "wp:extent")[0];
      const w = ext ? Math.round(Number(attr(ext, "cx") ?? "0") / 9525) : 0;
      const h = ext ? Math.round(Number(attr(ext, "cy") ?? "0") / 9525) : 0;
      return { file, w, h };
    }).filter((d): d is { file: string; w: number; h: number } => !!d.file && !!zip[d.file]);
    const decorative = draws.filter((d) => d.w > 0 && d.h > 0 && Math.max(d.w, d.h) <= DECORATIVE_PX);
    const contentImgs = draws.filter((d) => !decorative.includes(d));
    for (const d of contentImgs) {
      const key = d.file.replace(/^word\/media\//, "");
      media[key] = zip[d.file];
      pushBlock({ type: "image", src: key, w: d.w || undefined, h: d.h || undefined });
    }

    const text = paraText(el);
    if (!text) continue;
    const bold = paraIsBold(el);

    const h = headingInfo(text, bold, opts?.bareBoldHeadings);
    if (h) {
      // Inside an appendix, its own "1. Purpose / 2. …" restart numbering — keep
      // them as inline sub-headings rather than new top-level read-through sections.
      if (h.kind === "numbered" && inAppendix) {
        flushList();
        current.blocks.push({ type: "paragraph", text, bold: true });
        continue;
      }
      startSection(h.number, text);
      inAppendix = h.kind === "appendix";
      continue;
    }

    // PPE-style inline checklist: ≥2 tick marks (images or ☐/☑/☒ glyphs)
    // delimiting items in one paragraph → render a checklist rather than the
    // run-on collapsed line it would otherwise become.
    if ((decorative.length >= 2 || (text.match(BOX_RE) || []).length >= 2) && !contentImgs.length) {
      const items = inlineChecklist(el);
      if (items.length >= 2) { pushBlock({ type: "list", ordered: false, items }); continue; }
    }
    // Single checkbox per line ("☐ Harness inspected") — strip the glyph and
    // accumulate consecutive ones into one unordered checklist.
    const boxItem = text.match(/^[☐-☒□]\s*(.+)/);
    if (boxItem) {
      if (pendingList?.ordered) flushList();
      if (!pendingList) pendingList = { ordered: false, items: [] };
      pendingList.items.push(boxItem[1].trim());
      continue;
    }

    const numId = paraNumId(el);
    const styled = paraStyle(el) === "ListParagraph";
    if (numId || styled) {
      const ordered = numId ? numFmt.get(numId) ?? false : false;
      if (pendingList && pendingList.ordered !== ordered) flushList();
      if (!pendingList) pendingList = { ordered, items: [] };
      pendingList.items.push(text);
      continue;
    }
    flushList();
    if (WARN_RE.test(text)) current.blocks.push({ type: "callout", text });
    else current.blocks.push({ type: "paragraph", text, bold: bold || undefined });
  }
  flushList();
  if (started || current.blocks.length) sections.push(current);

  const title = sections.find((s) => s.number === "1")?.title || sections[0]?.title || "RAMS";
  return { doc: { title, sections: sections.filter((s) => s.blocks.length) }, media };
}
