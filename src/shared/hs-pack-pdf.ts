// Health & Safety pack PDF — pure builder shared by the client (manual
// download) and the worker (scheduled email release). No DOM/fetch: the logo
// arrives as bytes and the result returns as bytes.
//
// Sections: sign-in register (daily-briefing acceptance + drawn signatures),
// the briefing texts given in the period (tagged B1, B2, …), toolbox talks
// given (tagged T1, T2, … with the FULL copy and who acknowledged), and the
// operative qualification register. A4 landscape, PGP monochrome style.

import { PDFDocument, StandardFonts, rgb, PDFFont, PDFImage, PDFPage } from "pdf-lib";
import { COMPANY } from "./company";
import type { RamsBlock, RamsDoc, RiskScore } from "./rams";

const PAGE_W = 841.89; // A4 landscape
const PAGE_H = 595.28;
const MARGIN = 40;
const RIGHT = PAGE_W - MARGIN;

const INK = rgb(0.08, 0.09, 0.11);
const GREY = rgb(0.42, 0.43, 0.47);
const RED = rgb(0.72, 0.13, 0.13);
const RULE = rgb(0.85, 0.85, 0.86);
const RULE_DARK = rgb(0.25, 0.26, 0.28);
// Faithful toolbox-talk styling: PGP navy heading bands, a light fill for table
// header rows, and the cell-border grey the Word document uses.
const NAVY = rgb(0.08, 0.11, 0.22);
const BAND = rgb(0.90, 0.92, 0.95);   // heading band / table header fill
const CELL = rgb(0.70, 0.72, 0.76);   // table cell borders

// Register column left edges (Signature right-aligned to the margin).
const C = {
  date: MARGIN,
  name: MARGIN + 62,
  company: MARGIN + 188,
  trade: MARGIN + 300,
  in: MARGIN + 378,
  out: MARGIN + 416,
  briefing: MARGIN + 466,
  talks: MARGIN + 556,
  sigW: 84,
  sigH: 20,
};
const ROW_H = 26;

export type HsPackSignin = {
  id: number; name: string; company: string | null; trade: string | null;
  signature: string | null; signed_in_at: string; signed_out_at: string | null;
  signed_out_auto?: number | null;
  briefing_tag?: string | null;
};
export type HsPackAck = {
  signin_id: number | null; notice_id?: number | null; name: string; acked_at: string;
  notice_type: string; title: string; notice_date: string;
  /** The operative's drawn signature on a toolbox talk, and where they took it.
   *  This IS the record the paper register used to be, so the pack prints it. */
  signature?: string | null;
  company?: string | null;
  lat?: number | null; lng?: number | null; geo_status?: string | null;
};
export type HsPackBriefing = {
  tag: string; title: string; content: string | null; effective_from: string;
};
export type HsPackTalk = {
  id: number; title: string; content: string | null; notice_date: string; created_by: string | null;
  /** The parsed talk (same structure the operative read on their phone). When
   *  present the pack reproduces the document properly — headings, bullets,
   *  tables — instead of a flat wall of text. Falls back to `content`. */
  doc?: RamsDoc | null;
};
export type HsPackQual = {
  operative: string; company: string | null; trade: string | null;
  qual_type: string | null; card_no: string | null; expiry_date: string | null;
  verified_at: string | null; source: string | null;
};

export type HsPackInput = {
  projectCode: string;
  projectName: string;
  from: string;
  to: string;
  signins: HsPackSignin[];
  acks: HsPackAck[];
  briefings: HsPackBriefing[];
  /** When present, register rows tag talks (T1, T2, …) and the pack includes
   *  the full copy of each talk. Omit for the plain attendance export. */
  talks?: HsPackTalk[];
  /** When present, the pack ends with the operative qualification register. */
  quals?: HsPackQual[];
  logoPng?: Uint8Array | null;
  /** ISO date used for expiry highlighting (defaults to `to`). */
  today?: string;
};

const londonTime = (iso: string | null) => iso
  ? new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso))
  : "";
const londonDate = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", day: "2-digit", month: "short", year: "numeric" }).format(new Date(iso));

// pdf-lib fonts are WinAnsi — strip anything they can't encode (emoji etc.).
// Bullets/degrees/middle-dot ARE WinAnsi; newlines survive for wrapText.
const clean = (s: string) => s.replace(/[^\x20-\x7E\n£éèêàâçüö’‘“”–—•·°±]/g, "");

function truncate(f: PDFFont, text: string, size: number, maxW: number): string {
  text = text.replace(/\s+/g, " "); // single-line cells — no raw newlines
  if (f.widthOfTextAtSize(text, size) <= maxW) return text;
  let t = text;
  while (t.length > 1 && f.widthOfTextAtSize(`${t}…`, size) > maxW) t = t.slice(0, -1);
  return `${t}…`;
}

/** Word-wrap that honours the text's own line breaks. */
function wrapText(f: PDFFont, text: string, size: number, maxW: number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(""); continue; }
    let line = "";
    for (const w of words) {
      const probe = line ? `${line} ${w}` : w;
      if (f.widthOfTextAtSize(probe, size) <= maxW) line = probe;
      else { if (line) out.push(line); line = w; }
    }
    if (line) out.push(line);
  }
  return out;
}

type Ctx = { pdf: PDFDocument; page: PDFPage; reg: PDFFont; bold: PDFFont; logo: PDFImage | null; y: number; pageNo: number };

function footer(ctx: Ctx) {
  const { page, reg } = ctx;
  const text = `Company Registration No: ${COMPANY.company_number}.  Registered Office: ${COMPANY.registered_office}.`;
  const w = reg.widthOfTextAtSize(text, 7);
  page.drawText(text, { x: (PAGE_W - w) / 2, y: 22, font: reg, size: 7, color: GREY });
  const pn = `Page ${ctx.pageNo}`;
  page.drawText(pn, { x: RIGHT - reg.widthOfTextAtSize(pn, 7), y: 22, font: reg, size: 7, color: GREY });
}

function newPage(ctx: Ctx, title: string, sub: string[]) {
  ctx.page = ctx.pdf.addPage([PAGE_W, PAGE_H]);
  ctx.pageNo += 1;
  ctx.y = PAGE_H - MARGIN;
  const { page, reg, bold, logo } = ctx;
  if (logo) {
    const dims = logo.scale(28 / logo.height);
    page.drawImage(logo, { x: RIGHT - dims.width, y: ctx.y - 24, width: dims.width, height: dims.height });
  }
  page.drawText(title.toUpperCase(), { x: MARGIN, y: ctx.y - 14, font: bold, size: 15, color: INK });
  let sy = ctx.y - 30;
  for (const line of sub) {
    page.drawText(clean(line).replace(/\s+/g, " "), { x: MARGIN, y: sy, font: reg, size: 9, color: GREY });
    sy -= 12;
  }
  ctx.y = sy - 8;
  footer(ctx);
}

function registerHeader(ctx: Ctx) {
  const { page, bold } = ctx;
  const y = ctx.y;
  const h = (x: number, label: string) => page.drawText(label, { x, y, font: bold, size: 8, color: GREY });
  h(C.date, "DATE"); h(C.name, "NAME"); h(C.company, "COMPANY"); h(C.trade, "TRADE");
  h(C.in, "IN"); h(C.out, "OUT"); h(C.briefing, "DAILY BRIEFING"); h(C.talks, "TOOLBOX TALKS");
  page.drawText("SIGNATURE", { x: RIGHT - bold.widthOfTextAtSize("SIGNATURE", 8), y, font: bold, size: 8, color: GREY });
  page.drawLine({ start: { x: MARGIN, y: y - 5 }, end: { x: RIGHT, y: y - 5 }, thickness: 0.8, color: RULE_DARK });
  ctx.y = y - 5 - ROW_H;
}

function sectionTitle(ctx: Ctx, text: string) {
  ctx.y -= 8;
  ctx.page.drawText(text, { x: MARGIN, y: ctx.y, font: ctx.bold, size: 10, color: INK });
  ctx.y -= 18;
}

export async function buildHsPack(input: HsPackInput): Promise<Uint8Array> {
  const { projectCode, projectName, from, to, signins, acks, briefings, talks, quals } = input;
  const pdf = await PDFDocument.create();
  const reg = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let logo: PDFImage | null = null;
  if (input.logoPng?.length) { try { logo = await pdf.embedPng(input.logoPng); } catch { logo = null; } }
  const ctx: Ctx = { pdf, page: null as unknown as PDFPage, reg, bold, logo, y: 0, pageNo: 0 };

  const isPack = talks != null;
  const docTitle = isPack ? "Health & Safety pack" : "Attendance & briefing acceptance";
  const range = from === to ? londonDate(`${from}T12:00:00Z`) : `${londonDate(`${from}T12:00:00Z`)} – ${londonDate(`${to}T12:00:00Z`)}`;

  // Talks tagged T1… in date order; register rows reference the tags.
  const talkTags = new Map<number, string>();
  (talks ?? []).forEach((t, i) => talkTags.set(t.id, `T${i + 1}`));

  const sub = [
    `${projectCode}${projectName ? ` — ${projectName}` : ""}   ·   ${range}   ·   ${COMPANY.name}`,
    briefings.length === 0
      ? "No standing daily briefing was configured for this site during the period."
      : briefings.length === 1
        ? `Daily briefing in force (${briefings[0].tag}): “${briefings[0].title}” — acceptance is mandatory at sign-in; each sign-in below records the operative's acceptance. Full text ${isPack ? "inside" : "at the end"}.`
        : `The daily briefing changed during this period — each sign-in shows the version accepted (${briefings.map((b) => b.tag).join(", ")}); full texts ${isPack ? "inside" : "at the end"}. Acceptance is mandatory at sign-in.`,
  ];
  newPage(ctx, docTitle, sub);
  registerHeader(ctx);

  // Acknowledgements per sign-in. Keeps the whole ack, not just its label, so the
  // register can print the operative's talk signature beside the tag — the tag
  // alone says a talk was given; the signature says THIS person took it.
  const bySignin = new Map<number, Array<{ label: string; ack: HsPackAck }>>();
  for (const a of acks) {
    if (a.signin_id == null) continue;
    const label = isPack && a.notice_id != null && talkTags.has(a.notice_id)
      ? talkTags.get(a.notice_id)!
      : a.title;
    const list = bySignin.get(a.signin_id) ?? [];
    if (!list.some((e) => e.label === label)) list.push({ label, ack: a });
    bySignin.set(a.signin_id, list);
  }

  /** Embed a PNG data-URL once per distinct signature — the same operative signs
   *  on many rows, and re-embedding would bloat the file. */
  const sigCache = new Map<string, PDFImage | null>();
  async function embedSig(dataUrl: string | null | undefined): Promise<PDFImage | null> {
    if (!dataUrl?.startsWith("data:image/png;base64,")) return null;
    if (sigCache.has(dataUrl)) return sigCache.get(dataUrl)!;
    let img: PDFImage | null = null;
    try { img = await pdf.embedPng(Uint8Array.from(atob(dataUrl.slice("data:image/png;base64,".length)), (c) => c.charCodeAt(0))); }
    catch { img = null; }
    sigCache.set(dataUrl, img);
    return img;
  }

  const drawCell = (x: number, text: string, maxW: number, muted = false, boldFace = false) => {
    const f = boldFace ? bold : reg;
    ctx.page.drawText(truncate(f, clean(text), 8, maxW), { x, y: ctx.y + ROW_H / 2 - 3, font: f, size: 8, color: muted ? GREY : INK });
  };

  if (!signins.length) {
    ctx.page.drawText("No sign-ins in this range.", { x: MARGIN, y: ctx.y, font: reg, size: 9, color: GREY });
  }
  for (const s of signins) {
    if (ctx.y < MARGIN + 30) {
      newPage(ctx, `${docTitle} (continued)`, sub.slice(0, 1));
      registerHeader(ctx);
    }
    drawCell(C.date, londonDate(s.signed_in_at), C.name - C.date - 6);
    drawCell(C.name, s.name, C.company - C.name - 6, false, true);
    drawCell(C.company, s.company ?? "—", C.trade - C.company - 6, !s.company);
    drawCell(C.trade, s.trade ?? "—", C.in - C.trade - 6, !s.trade);
    drawCell(C.in, londonTime(s.signed_in_at), C.out - C.in - 4);
    drawCell(C.out, s.signed_out_at ? `${londonTime(s.signed_out_at)}${s.signed_out_auto ? "*" : ""}` : "—", C.briefing - C.out - 4, !s.signed_out_at);
    drawCell(C.briefing, s.briefing_tag ? `Accepted ${londonTime(s.signed_in_at)} · ${s.briefing_tag}` : "n/a", C.talks - C.briefing - 6, !s.briefing_tag);
    // Toolbox talks: the tag, then THAT operative's signature on the talk right
    // beside it. A tag alone only says a talk was given to the site; the
    // signature next to it says this person took it.
    const taken = bySignin.get(s.id) ?? [];
    const talksW = RIGHT - C.sigW - C.talks - 8;
    if (!taken.length) {
      drawCell(C.talks, "—", talksW, true);
    } else {
      let tx = C.talks;
      for (const { label, ack } of taken) {
        if (tx > C.talks + talksW - 12) { // out of room — say so rather than silently drop
          ctx.page.drawText("…", { x: tx, y: ctx.y + ROW_H / 2 - 3, font: reg, size: 8, color: GREY });
          break;
        }
        ctx.page.drawText(label, { x: tx, y: ctx.y + ROW_H / 2 - 3, font: bold, size: 8, color: INK });
        tx += bold.widthOfTextAtSize(label, 8) + 3;
        const sig = await embedSig(ack.signature);
        if (sig) {
          const scale = Math.min(52 / sig.width, (ROW_H - 8) / sig.height);
          const w = sig.width * scale;
          if (tx + w <= C.talks + talksW) {
            ctx.page.drawImage(sig, { x: tx, y: ctx.y + (ROW_H - sig.height * scale) / 2 - 2, width: w, height: sig.height * scale });
            tx += w + 8;
          }
        } else {
          tx += 6; // no signature on this one (acked at sign-in, not from the link)
        }
      }
    }
    const inSig = await embedSig(s.signature);
    if (inSig) {
      const scale = Math.min(C.sigW / inSig.width, C.sigH / inSig.height);
      ctx.page.drawImage(inSig, { x: RIGHT - C.sigW, y: ctx.y + (ROW_H - inSig.height * scale) / 2 - 2, width: inSig.width * scale, height: inSig.height * scale });
    } else {
      drawCell(RIGHT - C.sigW, s.signature ? "(on file)" : "—", C.sigW, true);
    }
    ctx.page.drawLine({ start: { x: MARGIN, y: ctx.y - 4 }, end: { x: RIGHT, y: ctx.y - 4 }, thickness: 0.4, color: RULE });
    ctx.y -= ROW_H;
  }

  if (signins.some((s) => s.signed_out_auto)) {
    if (ctx.y < MARGIN + 16) newPage(ctx, `${docTitle} (continued)`, sub.slice(0, 1));
    ctx.page.drawText("* No sign-out was recorded — closed automatically at 19:00 (UK time).", { x: MARGIN, y: ctx.y, font: reg, size: 7.5, color: GREY });
    ctx.y -= 16;
  }

  // ── Daily briefings given — full text per version. ──
  if (briefings.length) {
    if (ctx.y < MARGIN + 90) newPage(ctx, `${docTitle} (continued)`, sub.slice(0, 1));
    sectionTitle(ctx, briefings.length === 1 ? "DAILY BRIEFING GIVEN" : "DAILY BRIEFINGS GIVEN");
    for (const b of briefings) {
      drawCopyBlock(ctx, `${b.tag} — ${b.title}`, `In force from ${londonDate(b.effective_from)} ${londonTime(b.effective_from)}`, b.content, sub[0]);
    }
  }

  // ── Toolbox talks given — tagged, full copy, who acknowledged. ──
  if (isPack && talks!.length) {
    if (ctx.y < MARGIN + 90) newPage(ctx, "Toolbox talks (continued)", sub.slice(0, 1));
    sectionTitle(ctx, "TOOLBOX TALKS GIVEN");
    for (const t of talks!) {
      const tag = talkTags.get(t.id)!;
      const ackList = acks.filter((a) => a.notice_id === t.id);
      const meta = `Given ${londonDate(`${t.notice_date}T12:00:00Z`)}${t.created_by ? ` by ${t.created_by}` : ""}`;
      // Reproduce the document as delivered — headings, bullets, tables — then
      // the signed register. A PDF talk or one typed by hand has no parsed doc,
      // so its text is all there is; the register follows either way.
      drawCopyBlock(ctx, `${tag} — ${t.title}`, meta, t.doc?.sections?.length ? null : t.content, sub[0]);
      if (t.doc?.sections?.length) drawTalkDoc(ctx, t.doc, sub[0]);
      await drawTalkRegister(ctx, ackList, sub[0]);
    }
  } else if (!isPack && acks.length) {
    // Plain attendance export keeps the flat acknowledgement list.
    if (ctx.y < MARGIN + 80) newPage(ctx, `${docTitle} (continued)`, sub.slice(0, 1));
    sectionTitle(ctx, "RECORDED ACKNOWLEDGEMENTS");
    const A = { date: MARGIN, time: MARGIN + 70, name: MARGIN + 110, type: MARGIN + 250, title: MARGIN + 340 };
    const ah = (x: number, label: string) => ctx.page.drawText(label, { x, y: ctx.y, font: bold, size: 8, color: GREY });
    ah(A.date, "DATE"); ah(A.time, "TIME"); ah(A.name, "NAME"); ah(A.type, "TYPE"); ah(A.title, "TITLE");
    ctx.page.drawLine({ start: { x: MARGIN, y: ctx.y - 5 }, end: { x: RIGHT, y: ctx.y - 5 }, thickness: 0.8, color: RULE_DARK });
    ctx.y -= 21;
    for (const a of acks) {
      if (ctx.y < MARGIN + 14) { newPage(ctx, "Recorded acknowledgements (continued)", sub.slice(0, 1)); ctx.y -= 4; }
      const cell = (x: number, text: string, maxW: number) =>
        ctx.page.drawText(truncate(reg, clean(text), 8, maxW), { x, y: ctx.y, font: reg, size: 8, color: INK });
      cell(A.date, londonDate(a.acked_at), A.time - A.date - 6);
      cell(A.time, londonTime(a.acked_at), A.name - A.time - 6);
      cell(A.name, a.name, A.type - A.name - 6);
      cell(A.type, a.notice_type === "toolbox" ? "Toolbox talk" : "Briefing", A.title - A.type - 6);
      cell(A.title, a.title, RIGHT - A.title);
      ctx.page.drawLine({ start: { x: MARGIN, y: ctx.y - 4 }, end: { x: RIGHT, y: ctx.y - 4 }, thickness: 0.4, color: RULE });
      ctx.y -= 16;
    }
  }

  // ── Operative qualification register. ──
  if (quals) {
    if (ctx.y < MARGIN + 110) newPage(ctx, "Operative qualifications", sub.slice(0, 1));
    sectionTitle(ctx, "OPERATIVE QUALIFICATIONS");
    const todayISO = (input.today ?? to).slice(0, 10);
    const soonISO = new Date(Date.parse(`${todayISO}T12:00:00Z`) + 60 * 86_400_000).toISOString().slice(0, 10);
    const Q = { name: MARGIN, company: MARGIN + 150, trade: MARGIN + 280, qual: MARGIN + 380, card: MARGIN + 520, expiry: MARGIN + 630, status: MARGIN + 700 };
    const qh = (x: number, label: string) => ctx.page.drawText(label, { x, y: ctx.y, font: bold, size: 8, color: GREY });
    qh(Q.name, "OPERATIVE"); qh(Q.company, "COMPANY"); qh(Q.trade, "TRADE"); qh(Q.qual, "QUALIFICATION"); qh(Q.card, "CARD / REF"); qh(Q.expiry, "EXPIRY"); qh(Q.status, "STATUS");
    ctx.page.drawLine({ start: { x: MARGIN, y: ctx.y - 5 }, end: { x: RIGHT, y: ctx.y - 5 }, thickness: 0.8, color: RULE_DARK });
    ctx.y -= 20;
    if (!quals.length) {
      ctx.page.drawText("No operatives are assigned to this site.", { x: MARGIN, y: ctx.y, font: reg, size: 9, color: GREY });
      ctx.y -= 16;
    }
    let lastOperative = "";
    for (const q of quals) {
      if (ctx.y < MARGIN + 14) {
        newPage(ctx, "Operative qualifications (continued)", sub.slice(0, 1));
        qh(Q.name, "OPERATIVE"); qh(Q.company, "COMPANY"); qh(Q.trade, "TRADE"); qh(Q.qual, "QUALIFICATION"); qh(Q.card, "CARD / REF"); qh(Q.expiry, "EXPIRY"); qh(Q.status, "STATUS");
        ctx.page.drawLine({ start: { x: MARGIN, y: ctx.y - 5 }, end: { x: RIGHT, y: ctx.y - 5 }, thickness: 0.8, color: RULE_DARK });
        ctx.y -= 20;
        lastOperative = "";
      }
      const firstOfOperative = q.operative !== lastOperative;
      lastOperative = q.operative;
      const cell = (x: number, text: string, maxW: number, opts?: { muted?: boolean; boldFace?: boolean; red?: boolean }) =>
        ctx.page.drawText(truncate(opts?.boldFace ? bold : reg, clean(text), 8, maxW), {
          x, y: ctx.y, font: opts?.boldFace ? bold : reg, size: 8,
          color: opts?.red ? RED : opts?.muted ? GREY : INK,
        });
      if (firstOfOperative) {
        cell(Q.name, q.operative, Q.company - Q.name - 6, { boldFace: true });
        cell(Q.company, q.company ?? "—", Q.trade - Q.company - 6, { muted: !q.company });
        cell(Q.trade, q.trade ?? "—", Q.qual - Q.trade - 6, { muted: !q.trade });
      }
      if (q.qual_type) {
        const expired = !!q.expiry_date && q.expiry_date < todayISO;
        const expiring = !expired && !!q.expiry_date && q.expiry_date <= soonISO;
        cell(Q.qual, q.qual_type, Q.card - Q.qual - 6);
        cell(Q.card, q.card_no ?? "—", Q.expiry - Q.card - 6, { muted: !q.card_no });
        cell(Q.expiry, q.expiry_date ? londonDate(`${q.expiry_date}T12:00:00Z`) : "no expiry", Q.status - Q.expiry - 6, { muted: !q.expiry_date, red: expired });
        cell(Q.status, expired ? "EXPIRED" : expiring ? "Expiring soon" : q.verified_at ? "Verified" : "Unverified",
          RIGHT - Q.status, { red: expired, muted: !expired && !expiring && !q.verified_at });
      } else {
        cell(Q.qual, "No qualifications recorded", RIGHT - Q.qual, { muted: true });
      }
      ctx.page.drawLine({ start: { x: MARGIN, y: ctx.y - 4 }, end: { x: RIGHT, y: ctx.y - 4 }, thickness: 0.4, color: RULE });
      ctx.y -= 16;
    }
  }

  return await pdf.save();
}

/** Titled block with right-aligned meta, wrapped body text and an optional
 *  trailing note (used for briefing texts and toolbox-talk copies). */
/* ── Structured talk copy ────────────────────────────────────────────────────
 * Reproduces the talk as the operative read it: section headings, paragraphs,
 * bullets, tables and callouts — not a text blob. The pack is the H&S record,
 * so it has to show the document that was actually delivered.
 */
const TALK_W = RIGHT - MARGIN - 14;          // copy is indented under its heading
const TALK_X = MARGIN + 14;

/** Advance the cursor, breaking to a new page first if `need` points won't fit. */
function room(ctx: Ctx, need: number, contSub: string) {
  if (ctx.y - need < MARGIN + 12) newPage(ctx, "Toolbox talks (continued)", [contSub]);
}

/** A drawn checkbox (WinAnsi has no ☑, so vector it): a ruled square with a tick
 *  when required. The Word talk shows required PPE as ticked boxes. */
function drawCheckbox(ctx: Ctx, x: number, y: number, ticked: boolean) {
  ctx.page.drawRectangle({ x, y: y - 1, width: 8, height: 8, borderColor: RULE_DARK, borderWidth: 0.8 });
  if (ticked) {
    ctx.page.drawLine({ start: { x: x + 1.6, y: y + 3 }, end: { x: x + 3.3, y: y + 0.6 }, thickness: 1, color: NAVY });
    ctx.page.drawLine({ start: { x: x + 3.3, y: y + 0.6 }, end: { x: x + 6.6, y: y + 6 }, thickness: 1, color: NAVY });
  }
}

function drawTalkBlocks(ctx: Ctx, blocks: RamsBlock[], contSub: string, depth = 0, opts?: { checklist?: boolean }) {
  const { reg, bold } = ctx;
  const x = TALK_X + depth * 10;
  const w = TALK_W - depth * 10;
  for (const b of blocks) {
    switch (b.type) {
      case "paragraph": {
        const f = b.bold ? bold : reg;
        for (const line of wrapText(f, clean(b.text), 8, w)) {
          room(ctx, 11, contSub);
          ctx.page.drawText(line, { x, y: ctx.y, font: f, size: 8, color: INK });
          ctx.y -= 11;
        }
        ctx.y -= 3;
        break;
      }
      case "list": {
        // PPE / checklist sections: reproduce the Word doc's ticked-box grid —
        // required kit laid out two columns wide, each with a checkbox.
        if (opts?.checklist) {
          const cols = b.items.length > 4 ? 2 : 1;
          const cw = w / cols;
          for (let i = 0; i < b.items.length; i += cols) {
            room(ctx, 13, contSub);
            for (let c = 0; c < cols && i + c < b.items.length; c++) {
              const cx = x + c * cw;
              drawCheckbox(ctx, cx, ctx.y, true);
              ctx.page.drawText(truncate(reg, clean(b.items[i + c]), 8, cw - 16), { x: cx + 13, y: ctx.y, font: reg, size: 8, color: INK });
            }
            ctx.y -= 13;
          }
          ctx.y -= 3;
          break;
        }
        b.items.forEach((item, i) => {
          const marker = b.ordered ? `${i + 1}.` : "•";
          const mw = reg.widthOfTextAtSize(`${marker} `, 8);
          const lines = wrapText(reg, clean(item), 8, w - mw);
          lines.forEach((line, li) => {
            room(ctx, 11, contSub);
            if (li === 0) ctx.page.drawText(marker, { x, y: ctx.y, font: reg, size: 8, color: GREY });
            ctx.page.drawText(line, { x: x + mw, y: ctx.y, font: reg, size: 8, color: INK });
            ctx.y -= 11;
          });
        });
        ctx.y -= 3;
        break;
      }
      case "keyvalue": {
        for (const r of b.rows) {
          room(ctx, 11, contSub);
          const label = `${clean(r.label)}: `;
          ctx.page.drawText(truncate(bold, label, 8, w * 0.35), { x, y: ctx.y, font: bold, size: 8, color: INK });
          const lw = bold.widthOfTextAtSize(label, 8);
          for (const [i, line] of wrapText(reg, clean(r.value), 8, w - lw).entries()) {
            if (i > 0) { room(ctx, 11, contSub); }
            ctx.page.drawText(line, { x: x + lw, y: ctx.y, font: reg, size: 8, color: INK });
            ctx.y -= 11;
          }
        }
        ctx.y -= 3;
        break;
      }
      case "callout": {
        // Ruled left edge — the talk's warnings must not read as body text.
        const lines = wrapText(bold, clean(b.text), 8, w - 8);
        room(ctx, lines.length * 11 + 4, contSub);
        const top = ctx.y + 8;
        for (const line of lines) {
          room(ctx, 11, contSub);
          ctx.page.drawText(line, { x: x + 8, y: ctx.y, font: bold, size: 8, color: INK });
          ctx.y -= 11;
        }
        ctx.page.drawLine({ start: { x, y: top }, end: { x, y: ctx.y + 8 }, thickness: 2, color: RULE_DARK });
        ctx.y -= 4;
        break;
      }
      case "table":
      case "riskRegister": {
        const headers = b.type === "table" ? b.headers : ["Ref", "Hazard", "Who", "Risk", "Controls", "Residual"];
        const rows = b.type === "table" ? b.rows : b.rows.map((r) => [
          r.ref ?? "", r.hazard ?? "", r.who ?? "", scoreText(r.initial),
          (r.controls ?? []).join("\n"), scoreText(r.residual),
        ]);
        if (!headers.length && !rows.length) break;
        // Reproduce the Word document's grid: a shaded header row and full cell
        // borders, rather than a couple of ruled lines.
        const ncol = Math.max(1, headers.length || rows[0]?.length || 1);
        const colW = w / ncol;
        const pad = 4;
        // A single-cell "header" (e.g. the "TOOLBOX TALK" title band) has no data
        // columns to line up under, so treat the header as a full-width band.
        const headerIsBand = headers.length === 1 && rows.every((r) => r.length === 1);
        const drawGridRow = (cells: string[], f: PDFFont, fill?: ReturnType<typeof rgb>) => {
          const wrapped = cells.map((c) => wrapText(f, clean(c), 7, (headerIsBand ? w : colW) - pad * 2));
          const rowH = Math.max(14, Math.max(1, ...wrapped.map((c) => c.length)) * 9 + 6);
          room(ctx, rowH, contSub);
          const top = ctx.y;
          if (fill) ctx.page.drawRectangle({ x, y: top - rowH + 4, width: w, height: rowH, color: fill });
          const cw = headerIsBand ? w : colW;
          wrapped.forEach((lines, i) => {
            // Vertical cell border (skip the far-left; the outer rect draws it).
            if (i > 0 && !headerIsBand) ctx.page.drawLine({ start: { x: x + i * cw, y: top + 4 }, end: { x: x + i * cw, y: top - rowH + 4 }, thickness: 0.5, color: CELL });
            lines.forEach((line, li) => {
              ctx.page.drawText(line, { x: x + i * cw + pad, y: top - 4 - li * 9, font: f, size: 7, color: INK });
            });
          });
          // Row box.
          ctx.page.drawRectangle({ x, y: top - rowH + 4, width: w, height: rowH, borderColor: CELL, borderWidth: 0.5 });
          ctx.y = top - rowH;
        };
        // Header row (shaded). A single-column header is the title band.
        if (headers.some((h) => h.trim())) drawGridRow(headers, bold, BAND);
        for (const r of rows) drawGridRow(r, reg);
        ctx.y -= 6;
        break;
      }
      case "rawPage":
        drawTalkBlocks(ctx, b.blocks, contSub, depth);
        break;
      case "image":
        // Media lives in R2 behind a URL; the pack builder is byte-only and
        // can't fetch. Note it so the reader knows the doc had a figure here.
        room(ctx, 11, contSub);
        ctx.page.drawText(`[image: ${clean(b.alt || "figure")}]`, { x, y: ctx.y, font: reg, size: 7.5, color: GREY });
        ctx.y -= 12;
        break;
    }
  }
}

/** "3×4 = 12" — likelihood × severity, with the rating the doc gave (or the product). */
function scoreText(s: RiskScore | null | undefined): string {
  if (!s) return "";
  const parts = [s.likelihood, s.severity].filter((n): n is number => typeof n === "number");
  const rating = typeof s.rating === "number" ? s.rating
    : parts.length === 2 ? parts[0] * parts[1] : null;
  if (!parts.length) return rating != null ? String(rating) : "";
  return `${parts.join("×")}${rating != null ? ` = ${rating}` : ""}`;
}

/** The talk's attendance register: who took it, when, where, and their drawn
 *  signature. This replaces the paper sign-round sheet, so it has to carry the
 *  same evidence — a list of names alone proves nothing. */
async function drawTalkRegister(ctx: Ctx, acks: HsPackAck[], contSub: string) {
  const { reg, bold } = ctx;
  if (!acks.length) {
    room(ctx, 12, contSub);
    ctx.page.drawText("No acknowledgements recorded in this period.", { x: TALK_X, y: ctx.y, font: reg, size: 7.5, color: GREY });
    ctx.y -= 12;
  } else {
    const A = { name: TALK_X, company: TALK_X + 150, when: TALK_X + 270, where: TALK_X + 360, sig: RIGHT - 90 };
    room(ctx, 26, contSub);
    ctx.page.drawText(`ACKNOWLEDGED BY (${acks.length})`, { x: TALK_X, y: ctx.y, font: bold, size: 7.5, color: GREY });
    ctx.y -= 12;
    const h = (x: number, t: string) => ctx.page.drawText(t, { x, y: ctx.y, font: bold, size: 6.5, color: GREY });
    h(A.name, "NAME"); h(A.company, "COMPANY"); h(A.when, "SIGNED"); h(A.where, "LOCATION");
    ctx.page.drawText("SIGNATURE", { x: A.sig, y: ctx.y, font: bold, size: 6.5, color: GREY });
    ctx.page.drawLine({ start: { x: TALK_X, y: ctx.y - 4 }, end: { x: RIGHT, y: ctx.y - 4 }, thickness: 0.6, color: RULE_DARK });
    ctx.y -= 20;
    for (const a of acks) {
      room(ctx, 22, contSub);
      const cell = (x: number, t: string, w: number, grey = false) =>
        ctx.page.drawText(truncate(reg, clean(t), 7, w), { x, y: ctx.y, font: reg, size: 7, color: grey ? GREY : INK });
      cell(A.name, a.name, A.company - A.name - 6);
      cell(A.company, a.company || "—", A.when - A.company - 6, !a.company);
      cell(A.when, `${londonDate(a.acked_at)} ${londonTime(a.acked_at)}`, A.where - A.when - 6);
      // Location is the proof they were on site — say so plainly, or say it wasn't taken.
      const where = a.lat != null && a.lng != null ? `${a.lat.toFixed(5)}, ${a.lng.toFixed(5)}`
        : a.geo_status === "denied" ? "not recorded (location off)"
        : "not recorded";
      cell(A.where, where, A.sig - A.where - 8, a.lat == null);
      if (a.signature?.startsWith("data:image/png;base64,")) {
        try {
          const png = await ctx.pdf.embedPng(Uint8Array.from(atob(a.signature.slice("data:image/png;base64,".length)), (ch) => ch.charCodeAt(0)));
          const scale = Math.min(84 / png.width, 16 / png.height);
          ctx.page.drawImage(png, { x: A.sig, y: ctx.y - 3, width: png.width * scale, height: png.height * scale });
        } catch { cell(A.sig, "(signature unreadable)", 84, true); }
      } else {
        cell(A.sig, "—", 84, true);
      }
      ctx.page.drawLine({ start: { x: TALK_X, y: ctx.y - 5 }, end: { x: RIGHT, y: ctx.y - 5 }, thickness: 0.3, color: RULE });
      ctx.y -= 19;
    }
  }
  ctx.page.drawLine({ start: { x: MARGIN, y: ctx.y - 3 }, end: { x: RIGHT, y: ctx.y - 3 }, thickness: 0.4, color: RULE });
  ctx.y -= 16;
}

/** The full talk, section by section, as delivered — reproducing the Word
 *  document's look: shaded heading bands, bordered tables, ticked PPE boxes. */
function drawTalkDoc(ctx: Ctx, doc: RamsDoc, contSub: string) {
  const { bold } = ctx;
  for (const s of doc.sections) {
    const heading = [s.number, s.title].filter(Boolean).join(". ");
    if (heading) {
      // Shaded band behind the heading, the way the source document sets its
      // section titles off from the body.
      room(ctx, 18, contSub);
      ctx.page.drawRectangle({ x: MARGIN, y: ctx.y - 4, width: RIGHT - MARGIN, height: 15, color: BAND });
      ctx.page.drawText(truncate(bold, clean(heading), 9, RIGHT - MARGIN - 12), { x: MARGIN + 6, y: ctx.y, font: bold, size: 9, color: NAVY });
      ctx.y -= 19;
    }
    // A "PPE" section's list is the required-kit checklist — render ticked boxes.
    const checklist = /\bppe\b|protective equipment/i.test(s.title);
    drawTalkBlocks(ctx, s.blocks, contSub, 1, { checklist });
  }
}

function drawCopyBlock(ctx: Ctx, head: string, meta: string, content: string | null, contSub: string, note?: string) {
  const { reg, bold } = ctx;
  const contentLines = content ? wrapText(reg, clean(content), 8, RIGHT - MARGIN - 14) : [];
  const noteLines = note ? wrapText(reg, clean(note), 7.5, RIGHT - MARGIN - 14) : [];
  if (ctx.y < MARGIN + 40) newPage(ctx, "Health & Safety pack (continued)", [contSub]);
  ctx.page.drawText(clean(truncate(bold, head, 9.5, RIGHT - MARGIN - 180)), { x: MARGIN, y: ctx.y, font: bold, size: 9.5, color: INK });
  ctx.page.drawText(meta, { x: RIGHT - reg.widthOfTextAtSize(meta, 8), y: ctx.y, font: reg, size: 8, color: GREY });
  ctx.y -= 14;
  for (const line of contentLines) {
    if (ctx.y < MARGIN + 12) newPage(ctx, "Health & Safety pack (continued)", [contSub]);
    ctx.page.drawText(line, { x: MARGIN + 14, y: ctx.y, font: reg, size: 8, color: INK });
    ctx.y -= 11;
  }
  for (const line of noteLines) {
    if (ctx.y < MARGIN + 12) newPage(ctx, "Health & Safety pack (continued)", [contSub]);
    ctx.page.drawText(line, { x: MARGIN + 14, y: ctx.y, font: reg, size: 7.5, color: GREY });
    ctx.y -= 10;
  }
  ctx.page.drawLine({ start: { x: MARGIN, y: ctx.y - 3 }, end: { x: RIGHT, y: ctx.y - 3 }, thickness: 0.4, color: RULE });
  ctx.y -= 16;
}
