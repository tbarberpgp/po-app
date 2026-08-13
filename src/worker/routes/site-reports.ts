// Daily / weekly site reporting. Field updates land in project_updates (via the
// /pub/site-report-ingest webhook, manual entry, or email). This module turns a
// period's updates into a structured report with Claude, stores it, serves it to
// the app, and emails it. The daily/weekly cron runners live here too so the
// scheduled handler can reuse the same generation path as the in-app button.

import { Hono } from "hono";
import Anthropic from "@anthropic-ai/sdk";
import type { Env, Variables } from "../env";
import { requirePermission } from "../auth";
import { isSandboxId } from "../sandbox";
import { isSafeMediaUrl } from "../safe-url";
import { reportPdfAttachment, renderReportPdf, type ReportForPdf } from "./report-pdf";

export const siteReports = new Hono<{ Bindings: Env; Variables: Variables }>();

// The model the rest of the app already uses successfully (vision-capable).
// NB: a Sonnet alias was tried for cost but the account rejected it — switch
// here once the correct Sonnet model string is confirmed.
const MODEL = "claude-opus-4-7";
const TRANSCRIPT_CAP = 14000; // chars of context sent to the model

export type ReportSections = {
  headline: string;
  labour_count: string;          // operatives on site (as stated in the chat)
  weather: string;               // weather summary for the period
  progress: string[];
  deliveries: string[];
  labour: string[];
  hse: string[];
  blockers: string[];
  lookahead: string[];
  photos: Array<{ url: string; caption: string }>;
  // ── data-backed sections (Site-Report full build) ──
  weather_days: Array<{ date: string; code: number; min: number; max: number; precip: number }>;
  labour_days: Array<{ date: string; count: number }>; // headcount per day, from site sign-ins
  plant: string[];               // plant on site (hired, not yet off-hired)
  safety: { incidents: number; near_misses: number; toolbox_talks: number; rams_outstanding?: number };
  // Live programme position as of the report date (from the imported programme).
  programme?: { day: number; total_days: number; pct_overall: number; status: string } | null;
  // Sign-in attendance for the period (from site_signins). `visitors` = signed-in
  // people not on the active operative register (client reps, surveyors, etc.).
  attendance?: { on_site: number; companies: number; first_in: string | null; last_out: string | null; inductions?: number; visitors?: number } | null;
  // Labour broken down by company (from site sign-ins): headcount + hours, with
  // a best-effort trade breakdown matched against the operative register.
  labour_table?: Array<{ company: string; count: number; hours: number; trade: string }>;
  // Deliveries logged in the period (from site_deliveries).
  deliveries_detail?: Array<{ supplier: string; description: string; po_number: string | null; status: string }>;
  // Section keys hidden from the exported/emailed copy (via "Edit for client"),
  // and free-form sections the editor added. Persisted so the on-screen doc, the
  // PDF and the emailed copy all match.
  hidden_sections?: string[];
  custom_sections?: Array<{ title: string; items: string[] }>;
};
const SECTION_LABELS: Array<[keyof ReportSections, string]> = [
  ["progress", "Progress on site"],
  ["deliveries", "Deliveries & materials"],
  ["labour", "Labour"],
  ["plant", "Plant on site"],
  ["hse", "Safety & compliance"],
  ["blockers", "Delays & blockers"],
  ["lookahead", "Look-ahead / next steps"],
];

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** Monday→Sunday week containing `date` (ISO yyyy-mm-dd). */
function weekBounds(date: string): { start: string; end: string } {
  const d = new Date(date + "T00:00:00Z");
  const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
  const start = new Date(d); start.setUTCDate(d.getUTCDate() - dow);
  const end = new Date(start); end.setUTCDate(start.getUTCDate() + 6);
  return { start: ymd(start), end: ymd(end) };
}

type UpdateRow = { sender: string | null; body: string | null; occurred_at: string; media_url: string | null };

async function fetchUpdates(env: Env, projectId: string, start: string, end: string): Promise<UpdateRow[]> {
  const r = await env.DB.prepare(
    `SELECT sender, body, occurred_at, media_url FROM project_updates
      WHERE project_id = ? AND substr(occurred_at, 1, 10) BETWEEN ? AND ?
      ORDER BY occurred_at`,
  ).bind(projectId, start, end).all<UpdateRow>();
  return r.results;
}

function buildTranscript(rows: UpdateRow[]): string {
  let out = "";
  for (const r of rows) {
    const when = (r.occurred_at || "").replace("T", " ").slice(0, 16);
    const who = r.sender ? `${r.sender}: ` : "";
    const media = r.media_url ? " [photo/attachment]" : "";
    const line = `[${when}] ${who}${(r.body || "").trim()}${media}\n`;
    if (out.length + line.length > TRANSCRIPT_CAP) { out += "…(truncated)\n"; break; }
    out += line;
  }
  return out;
}

/** Summarise a transcript into structured report sections via Claude. Degrades
 *  to a plain roll-up when no API key is configured or the call fails. */
async function summarise(
  env: Env,
  transcript: string,
  meta: { project: string; periodType: "daily" | "weekly"; start: string; end: string; count: number },
): Promise<ReportSections> {
  const fallback = (): ReportSections => ({
    headline: `${meta.count} update${meta.count === 1 ? "" : "s"} logged${meta.count ? "" : " — quiet period"}.`,
    labour_count: "", weather: "",
    progress: transcript.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 20),
    deliveries: [], labour: [], hse: [], blockers: [], lookahead: [], photos: [],
    weather_days: [], labour_days: [], plant: [], safety: { incidents: 0, near_misses: 0, toolbox_talks: 0 },
  });
  if (!env.ANTHROPIC_API_KEY || meta.count === 0) return fallback();

  const period = meta.periodType === "daily" ? `the day ${meta.start}` : `the week ${meta.start} to ${meta.end}`;
  const system = `You are a construction project administrator writing a ${meta.periodType} site report for ${meta.project}, covering ${period}.
You are given the raw site-team WhatsApp/field messages for the period. Distil them into a concise, factual management report. Rules:
- Be specific and quantitative where the messages allow (areas, counts, deliveries, operative numbers).
- Each bullet is one short, plain sentence. No fluff, no repetition, no emojis.
- Only state what the messages support — never invent progress, deliveries or incidents. If a section has nothing, return an empty array for it.
- "headline" is a single sentence summarising overall status for the period.
- "labour_count": how many operatives/people were on site (e.g. "6", or "6 (4 roofers, 2 labourers)"). Empty string if not stated.
- "weather": the weather for the period if mentioned (e.g. "Dry, mild", "Heavy rain pm — stopped at 2pm"). Empty string if not mentioned.
- "incidents", "near_misses", "toolbox_talks": integer counts of each that the messages mention for the period (0 if none).
- Group content into the provided sections. Flag any safety incident, near-miss or RIDDOR clearly under hse. Put delays, RFIs, access problems, weather stops and outstanding decisions under blockers.`;

  try {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 1500,
      system,
      tools: [{
        name: "site_report",
        description: "Return the structured site report for the period.",
        input_schema: {
          type: "object" as const,
          properties: {
            headline: { type: "string", description: "One-sentence overall status for the period." },
            labour_count: { type: "string", description: "Operatives on site, as stated (e.g. '6'). Empty string if not stated." },
            weather: { type: "string", description: "Weather for the period if mentioned. Empty string if not." },
            incidents: { type: "integer", description: "Count of safety incidents mentioned (0 if none)." },
            near_misses: { type: "integer", description: "Count of near-misses mentioned (0 if none)." },
            toolbox_talks: { type: "integer", description: "Count of toolbox talks / briefings mentioned (0 if none)." },
            progress: { type: "array", items: { type: "string" }, description: "Work completed / advanced on site." },
            deliveries: { type: "array", items: { type: "string" }, description: "Materials/plant delivered or received." },
            labour: { type: "array", items: { type: "string" }, description: "Operatives, trades and plant on site." },
            hse: { type: "array", items: { type: "string" }, description: "Health & safety: incidents, near-misses, inspections, toolbox talks." },
            blockers: { type: "array", items: { type: "string" }, description: "Delays, RFIs, access issues, weather, outstanding decisions." },
            lookahead: { type: "array", items: { type: "string" }, description: "Planned next steps / what's coming up." },
          },
          required: ["headline", "progress", "deliveries", "labour", "hse", "blockers", "lookahead"],
        },
      }],
      tool_choice: { type: "tool", name: "site_report" },
      messages: [{ role: "user", content: `Messages for ${period}:\n\n${transcript || "(no messages)"}` }],
    });
    const block = res.content.find((b) => b.type === "tool_use");
    if (block && block.type === "tool_use") {
      const s = block.input as Partial<ReportSections>;
      const arr = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : [];
      const si = block.input as { incidents?: unknown; near_misses?: unknown; toolbox_talks?: unknown };
      const int = (v: unknown) => (typeof v === "number" && isFinite(v) && v > 0 ? Math.round(v) : 0);
      return {
        headline: typeof s.headline === "string" && s.headline.trim() ? s.headline.trim() : fallback().headline,
        labour_count: typeof s.labour_count === "string" ? s.labour_count.trim() : "",
        weather: typeof s.weather === "string" ? s.weather.trim() : "",
        progress: arr(s.progress), deliveries: arr(s.deliveries), labour: arr(s.labour),
        hse: arr(s.hse), blockers: arr(s.blockers), lookahead: arr(s.lookahead),
        photos: [],
        weather_days: [], labour_days: [], plant: [],
        safety: { incidents: int(si.incidents), near_misses: int(si.near_misses), toolbox_talks: int(si.toolbox_talks) },
      };
    }
  } catch (e) {
    console.warn("site-report summarise failed:", e instanceof Error ? e.message : e);
  }
  return fallback();
}

/** ArrayBuffer → base64 (chunked so large images don't blow the call stack). */
function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as unknown as number[]);
  }
  return btoa(bin);
}
function mediaType(m: string | null): "image/jpeg" | "image/png" | "image/gif" | "image/webp" {
  const t = (m || "").toLowerCase();
  return t.includes("png") ? "image/png" : t.includes("gif") ? "image/gif" : t.includes("webp") ? "image/webp" : "image/jpeg";
}

/**
 * AI vision: read each photo from R2 and ask Claude to describe its contents —
 * the work/area, materials & trades visible, and any obvious H&S concern. Returns
 * descriptions aligned to the input order ("" where none). Best-effort: any
 * failure (no key, oversized image, API error) leaves that slot blank so the
 * human caption is used instead.
 */
async function describePhotos(
  env: Env,
  rows: Array<{ file_key: string; file_type: string | null; caption: string | null }>,
): Promise<string[]> {
  const out: string[] = new Array(rows.length).fill("");
  if (!env.ANTHROPIC_API_KEY || rows.length === 0) return out;
  const imgs: Array<{ data: string; mime: ReturnType<typeof mediaType>; note: string }> = [];
  const idxMap: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    try {
      const obj = await env.R2.get(rows[i].file_key);
      if (!obj) continue;
      const buf = await obj.arrayBuffer();
      if (buf.byteLength > 4_000_000) continue; // keep under the vision size limit
      imgs.push({ data: toBase64(buf), mime: mediaType(rows[i].file_type), note: (rows[i].caption || "").trim() });
      idxMap.push(i);
    } catch { /* skip unreadable */ }
  }
  if (imgs.length === 0) return out;
  try {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const content = [
      ...imgs.flatMap((im, n) => [
        { type: "text" as const, text: `Photo ${n + 1}${im.note ? ` (site note: ${im.note})` : ""}:` },
        { type: "image" as const, source: { type: "base64" as const, media_type: im.mime, data: im.data } },
      ]),
      { type: "text" as const, text: "For each construction site photo above, in order, write a SHORT caption — a brief phrase of at most ~10 words naming what it shows (the work/area or materials visible). No full sentences, no preamble, no 'This photo shows…'. Only append a few words flagging a clearly serious hazard if one is obvious. Describe only what's visible." },
    ];
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 1000,
      tools: [{
        name: "describe_photos",
        description: "One factual description per photo, in the same order as provided.",
        input_schema: { type: "object" as const, properties: { descriptions: { type: "array", items: { type: "string" } } }, required: ["descriptions"] },
      }],
      tool_choice: { type: "tool", name: "describe_photos" },
      messages: [{ role: "user", content }],
    });
    const clamp = (s: string): string => {
      const t = s.trim().replace(/^(this (photo|image) shows|photo of|image of)\s*/i, "");
      if (t.length <= 90) return t;
      const c = t.slice(0, 90); const sp = c.lastIndexOf(" ");
      return (sp > 50 ? c.slice(0, sp) : c).replace(/[.,;:]+$/, "") + "…";
    };
    const block = res.content.find((b) => b.type === "tool_use");
    if (block && block.type === "tool_use") {
      const desc = (block.input as { descriptions?: unknown }).descriptions;
      if (Array.isArray(desc)) desc.forEach((d, n) => { if (typeof d === "string" && idxMap[n] != null) out[idxMap[n]] = clamp(d); });
    }
  } catch (e) { console.warn("photo vision failed:", e instanceof Error ? e.message : e); }
  return out;
}

function renderMarkdown(s: ReportSections): string {
  let md = `**${s.headline}**\n`;
  const meta: string[] = [];
  if (s.labour_count) meta.push(`Labour on site: ${s.labour_count}`);
  if (s.weather) meta.push(`Weather: ${s.weather}`);
  if (s.safety && (s.safety.incidents || s.safety.near_misses || s.safety.toolbox_talks)) {
    meta.push(`Safety: ${s.safety.incidents} incident${s.safety.incidents === 1 ? "" : "s"}, ${s.safety.near_misses} near-miss, ${s.safety.toolbox_talks} toolbox`);
  }
  if (meta.length) md += `\n${meta.join("  ·  ")}\n`;
  for (const [key, label] of SECTION_LABELS) {
    const items = s[key] as string[];
    if (items.length) md += `\n### ${label}\n${items.map((i) => `- ${i}`).join("\n")}\n`;
  }
  if (s.photos?.length) {
    md += `\n### Photos (${s.photos.length})\n${s.photos.map((p) => `- ${p.caption || "Site photo"}`).join("\n")}\n`;
  }
  return md.trim();
}

type StoredReport = {
  id: number; project_id: string | null; period_type: string; period_start: string; period_end: string;
  summary_md: string | null; data_json: string | null; update_count: number; status: string;
  generated_at: string; generated_by: string | null;
};

/**
 * Generate (and upsert) a site report for one project + period. Returns the
 * stored row. Reused by the in-app button and the daily/weekly cron.
 */
/** WMO weather code → short label. */
function weatherLabel(code: number): string {
  if (code === 0) return "Clear";
  if (code <= 2) return "Mainly clear";
  if (code === 3) return "Overcast";
  if (code === 45 || code === 48) return "Fog";
  if (code >= 51 && code <= 57) return "Drizzle";
  if (code >= 61 && code <= 67) return "Rain";
  if (code >= 71 && code <= 77) return "Snow";
  if (code >= 80 && code <= 82) return "Rain showers";
  if (code >= 85 && code <= 86) return "Snow showers";
  if (code >= 95) return "Thunderstorm";
  return "Mixed";
}

// Fallback so a daily report always carries weather even when a project has no
// address postcode and no GPS sign-in: the Power Grid Projects office (Buckingham,
// MK18 7SA). Approximate for far-flung sites — set the project's delivery-address
// postcode, or rely on GPS sign-ins, for pinpoint-accurate local weather.
const COMPANY_COORDS = { lat: 51.9966, lng: -0.9877 };

/** Site coordinates, most-accurate first: a UK postcode in the project's delivery
 *  address (geocoded via postcodes.io), then the most recent site sign-in's GPS
 *  (the actual site), then the company office as a last-resort fallback. */
async function siteCoords(env: Env, projectId: string): Promise<{ lat: number; lng: number }> {
  try {
    const p = await env.DB.prepare("SELECT delivery_address FROM projects WHERE id = ?").bind(projectId).first<{ delivery_address: string | null }>();
    const pc = (p?.delivery_address || "").match(/([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})/i)?.[1];
    if (pc) {
      const r = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(pc.replace(/\s+/g, ""))}`);
      if (r.ok) {
        const j = (await r.json()) as { result?: { latitude: number; longitude: number } };
        if (j.result) return { lat: j.result.latitude, lng: j.result.longitude };
      }
    }
  } catch { /* fall through to sign-in GPS */ }
  try {
    const ids = await signinScope(env, projectId);
    const ph = ids.map(() => "?").join(",");
    const s = await env.DB.prepare(
      `SELECT lat, lng FROM site_signins WHERE project_id IN (${ph}) AND lat IS NOT NULL ORDER BY signed_in_at DESC LIMIT 1`,
    ).bind(...ids).first<{ lat: number; lng: number }>();
    if (s?.lat != null && s?.lng != null) return { lat: s.lat, lng: s.lng };
  } catch { /* fall through to office */ }
  return COMPANY_COORDS;
}

type WeatherDay = { date: string; code: number; min: number; max: number; precip: number };
/** Actual weather for the site + period via Open-Meteo (free, no key). Returns a
 *  summary string + the per-day breakdown ("" / [] if location/API unavailable). */
async function fetchWeather(env: Env, projectId: string, start: string, end: string): Promise<{ summary: string; days: WeatherDay[] }> {
  const none = { summary: "", days: [] as WeatherDay[] };
  try {
    const c = await siteCoords(env, projectId);
    if (!c) return none;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${c.lat}&longitude=${c.lng}` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum&start_date=${start}&end_date=${end}&timezone=Europe%2FLondon`;
    const r = await fetch(url);
    if (!r.ok) return none;
    const j = (await r.json()) as { daily?: { time: string[]; weather_code: number[]; temperature_2m_max: number[]; temperature_2m_min: number[]; precipitation_sum: number[] } };
    const d = j.daily;
    if (!d || !d.time?.length) return none;
    const days: WeatherDay[] = d.time.map((date, i) => ({
      date, code: d.weather_code[i] ?? 3,
      min: Math.round(d.temperature_2m_min[i]), max: Math.round(d.temperature_2m_max[i]),
      precip: Math.round((d.precipitation_sum[i] ?? 0) * 10) / 10,
    }));
    let summary: string;
    if (days.length === 1) {
      const o = days[0];
      summary = `${weatherLabel(o.code)}, ${o.min}–${o.max}°C${o.precip >= 0.5 ? `, ${o.precip}mm rain` : ", dry"}`;
    } else {
      const rainDays = days.filter((x) => x.precip >= 1).length;
      const total = days.reduce((s2, x) => s2 + x.precip, 0);
      summary = `${Math.min(...days.map((x) => x.min))}–${Math.max(...days.map((x) => x.max))}°C, rain on ${rainDays} of ${days.length} days${total >= 0.5 ? ` (${total.toFixed(0)}mm)` : ""}`;
    }
    return { summary, days };
  } catch (e) { console.warn("weather fetch failed:", e instanceof Error ? e.message : e); return none; }
}

/** The projects whose site sign-ins count for this project's report: the whole
 *  site group (grouped blocks share one entrance — an operative signs in once at
 *  the base's QR and it counts for every block), else just the project itself.
 *  Sign-ins/inductions route to the base, so reading the group is what makes a
 *  member block's diary show the right headcount instead of 0. */
async function signinScope(env: Env, projectId: string): Promise<string[]> {
  try {
    const row = await env.DB.prepare("SELECT site_group_id FROM projects WHERE id = ?")
      .bind(projectId).first<{ site_group_id: string | null }>();
    if (!row?.site_group_id) return [projectId];
    const r = await env.DB.prepare("SELECT id FROM projects WHERE site_group_id = ? AND deleted_at IS NULL")
      .bind(row.site_group_id).all<{ id: string }>();
    return r.results.length ? r.results.map((x) => x.id) : [projectId];
  } catch { return [projectId]; }
}

/** Sign-in attendance for the period: distinct operatives, companies, and the
 *  earliest in / latest out (Europe/London) — the Labour detail on the report. */
async function attendanceSummary(
  env: Env, projectId: string, start: string, end: string,
): Promise<{ on_site: number; companies: number; first_in: string | null; last_out: string | null; inductions: number; visitors: number } | null> {
  try {
    const ids = await signinScope(env, projectId);
    const ph = ids.map(() => "?").join(",");
    const r = await env.DB.prepare(
      `SELECT COUNT(DISTINCT lower(name)) AS on_site,
              COUNT(DISTINCT lower(COALESCE(NULLIF(trim(company), ''), name))) AS companies,
              MIN(signed_in_at) AS first_in,
              MAX(COALESCE(signed_out_at, signed_in_at)) AS last_out
         FROM site_signins
        WHERE project_id IN (${ph}) AND substr(signed_in_at, 1, 10) BETWEEN ? AND ?`,
    ).bind(...ids, start, end).first<{ on_site: number; companies: number; first_in: string | null; last_out: string | null }>();
    if (!r || !r.on_site) return null;
    const hm = (iso: string | null) => {
      if (!iso) return null;
      const d = new Date(iso);
      return isNaN(d.getTime()) ? null : d.toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" });
    };
    let inductions = 0;
    try {
      const ir = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM site_inductions WHERE project_id IN (${ph}) AND substr(inducted_at, 1, 10) BETWEEN ? AND ?`,
      ).bind(...ids, start, end).first<{ n: number }>();
      inductions = ir?.n ?? 0;
    } catch { /* site_inductions absent */ }
    // Visitors = distinct signed-in people not on the active operative register
    // (i.e. not our labour) — client reps, surveyors, inspectors, drivers, etc.
    let visitors = 0;
    try {
      const vr = await env.DB.prepare(
        `SELECT COUNT(DISTINCT lower(ss.name)) AS n
           FROM site_signins ss
          WHERE ss.project_id IN (${ph}) AND substr(ss.signed_in_at, 1, 10) BETWEEN ? AND ?
            AND lower(ss.name) NOT IN (SELECT lower(name) FROM operatives WHERE archived_at IS NULL AND name IS NOT NULL)`,
      ).bind(...ids, start, end).first<{ n: number }>();
      visitors = vr?.n ?? 0;
    } catch { /* operatives absent */ }
    return { on_site: r.on_site, companies: r.companies, first_in: hm(r.first_in), last_out: hm(r.last_out), inductions, visitors };
  } catch { return null; }
}

/** Labour grouped by company for the period: distinct headcount + hours worked
 *  (where operatives signed out). Drives the report's labour table. */
async function labourTable(env: Env, projectId: string, start: string, end: string): Promise<Array<{ company: string; count: number; hours: number; trade: string }>> {
  try {
    const ids = await signinScope(env, projectId);
    const ph = ids.map(() => "?").join(",");
    const r = await env.DB.prepare(
      `SELECT COALESCE(NULLIF(trim(company), ''), 'Unspecified') AS company,
              COUNT(DISTINCT lower(name)) AS count,
              SUM(CASE WHEN signed_out_at IS NOT NULL THEN (julianday(signed_out_at) - julianday(signed_in_at)) * 24 ELSE 0 END) AS hours
         FROM site_signins
        WHERE project_id IN (${ph}) AND substr(signed_in_at, 1, 10) BETWEEN ? AND ?
        GROUP BY lower(COALESCE(NULLIF(trim(company), ''), 'unspecified'))
        ORDER BY count DESC, company`,
    ).bind(...ids, start, end).all<{ company: string; count: number; hours: number }>();
    // Best-effort trade breakdown — match signed-in names to the operative
    // register (e.g. "Roofer ×4, Labourer ×1"); blank where names don't match.
    const tradeByCo = new Map<string, string>();
    try {
      const tr = await env.DB.prepare(
        `SELECT COALESCE(NULLIF(trim(ss.company), ''), 'Unspecified') AS company, o.trade AS trade, COUNT(DISTINCT lower(ss.name)) AS n
           FROM site_signins ss
           JOIN operatives o ON lower(o.name) = lower(ss.name) AND o.archived_at IS NULL
          WHERE ss.project_id IN (${ph}) AND substr(ss.signed_in_at, 1, 10) BETWEEN ? AND ?
            AND o.trade IS NOT NULL AND trim(o.trade) <> ''
          GROUP BY company, o.trade ORDER BY n DESC`,
      ).bind(...ids, start, end).all<{ company: string; trade: string; n: number }>();
      const acc = new Map<string, string[]>();
      for (const x of tr.results) { const a = acc.get(x.company) ?? []; a.push(`${x.trade} ×${x.n}`); acc.set(x.company, a); }
      for (const [co, parts] of acc) tradeByCo.set(co, parts.join(", "));
    } catch { /* operatives table absent / join issue */ }
    return r.results.map((x) => ({ company: x.company, count: x.count, hours: Math.round((x.hours || 0) * 10) / 10, trade: tradeByCo.get(x.company) ?? "" }));
  } catch { return []; }
}

/** Deliveries logged in the period — supplier, what arrived, PO ref and status. */
async function deliveriesDetail(env: Env, projectId: string, start: string, end: string): Promise<Array<{ supplier: string; description: string; po_number: string | null; status: string }>> {
  try {
    const r = await env.DB.prepare(
      `SELECT COALESCE(supplier, '') AS supplier, COALESCE(description, '') AS description, po_number, COALESCE(status, 'received') AS status
         FROM site_deliveries
        WHERE project_id = ? AND substr(delivered_at, 1, 10) BETWEEN ? AND ?
        ORDER BY delivered_at DESC LIMIT 20`,
    ).bind(projectId, start, end).all<{ supplier: string; description: string; po_number: string | null; status: string }>();
    return r.results;
  } catch { return []; }
}

/** Outstanding RAMS acknowledgements: pending (unsigned) requests on active RAMS
 *  for operatives currently assigned to the project. */
async function ramsOutstanding(env: Env, projectId: string): Promise<number> {
  try {
    const r = await env.DB.prepare(
      `SELECT COUNT(*) AS n
         FROM operative_rams_signs s
         JOIN operatives o ON o.id = s.operative_id
         JOIN rams_documents d ON d.id = s.rams_id
        WHERE s.project_id = ? AND s.signed_at IS NULL AND d.active = 1
          AND o.assigned_project_id = ? AND o.archived_at IS NULL`,
    ).bind(projectId, projectId).first<{ n: number }>();
    return r?.n ?? 0;
  } catch { return 0; }
}

async function labourDays(env: Env, projectId: string, start: string, end: string): Promise<Array<{ date: string; count: number }>> {
  try {
    const ids = await signinScope(env, projectId);
    const ph = ids.map(() => "?").join(",");
    const r = await env.DB.prepare(
      `SELECT substr(signed_in_at,1,10) AS d, COUNT(DISTINCT lower(name)) AS n FROM site_signins
        WHERE project_id IN (${ph}) AND substr(signed_in_at,1,10) BETWEEN ? AND ? GROUP BY d ORDER BY d`,
    ).bind(...ids, start, end).all<{ d: string; n: number }>();
    return r.results.map((x) => ({ date: x.d, count: x.n }));
  } catch { return []; }
}

/** Plant currently on site (hired, not yet off-hired) for the project. */
async function plantOnSite(env: Env, projectId: string): Promise<string[]> {
  try {
    const r = await env.DB.prepare(
      "SELECT item, supplier FROM plant_logs WHERE project_id = ? AND off_hire_to IS NULL ORDER BY id",
    ).bind(projectId).all<{ item: string; supplier: string | null }>();
    return r.results.map((p) => (p.supplier ? `${p.item} — ${p.supplier}` : p.item));
  } catch { return []; }
}

/** Image MIME from content-type, falling back to the URL extension (Wasabi/S3
 *  links often serve images as application/octet-stream). Null if not an image. */
function imageMime(url: string, ct: string | null): string | null {
  if (ct && /^image\//i.test(ct)) return ct.split(";")[0].trim();
  const m = url.split("?")[0].match(/\.(jpe?g|png|gif|webp)$/i);
  if (!m) return null;
  const e = m[1].toLowerCase();
  return e === "jpg" || e === "jpeg" ? "image/jpeg" : `image/${e}`;
}

/** Pull any updates in the period that carry an image media_url but were never
 *  saved as a Site Photo (e.g. they arrived before photo-saving was live) into
 *  progress_photos. De-duped by the update id encoded in the file key (wa<id>). */
async function backfillPeriodPhotos(env: Env, projectId: string, start: string, end: string): Promise<void> {
  let ups;
  try {
    ups = await env.DB.prepare(
      `SELECT id, body, media_url, occurred_at FROM project_updates
        WHERE project_id = ? AND media_url IS NOT NULL AND substr(occurred_at, 1, 10) BETWEEN ? AND ? ORDER BY id`,
    ).bind(projectId, start, end).all<{ id: number; body: string | null; media_url: string; occurred_at: string }>();
  } catch { return; }
  const now = new Date().toISOString();
  for (const u of ups.results) {
    try {
      const exists = await env.DB.prepare(
        "SELECT 1 FROM progress_photos WHERE project_id = ? AND file_key LIKE ? LIMIT 1",
      ).bind(projectId, `progress/${projectId}/wa${u.id}-%`).first();
      if (exists) continue;
      if (!isSafeMediaUrl(u.media_url)) continue;
      const resp = await fetch(u.media_url);
      const mime = imageMime(u.media_url, resp.headers.get("content-type"));
      if (!resp.ok || !mime) continue;
      const key = `progress/${projectId}/wa${u.id}-${crypto.randomUUID()}.jpg`;
      await env.R2.put(key, await resp.arrayBuffer(), { httpMetadata: { contentType: mime } });
      await env.DB.prepare(
        `INSERT INTO progress_photos (project_id, file_key, file_type, caption, taken_on, created_at, created_by)
         VALUES (?,?,?,?,?,?,?)`,
      ).bind(projectId, key, mime, (u.body || "").trim() || null, (u.occurred_at || now).slice(0, 10), now, "whatsapp").run();
    } catch { /* skip unreadable */ }
  }
}

/**
 * Live programme position as of a date, from the project's imported programme:
 * day X of Y across the planned span, duration-weighted % complete, and a status
 * derived from % vs elapsed time. Returns null when no programme is imported.
 */
async function programmeSummary(
  env: Env, projectId: string, asOf: string,
): Promise<{ day: number; total_days: number; pct_overall: number; status: string } | null> {
  const rows = (await env.DB.prepare(
    `SELECT planned_start, planned_finish, pct_complete, duration_days
       FROM programme_activities
      WHERE project_id = ? AND COALESCE(is_summary, 0) = 0`,
  ).bind(projectId).all<{ planned_start: string | null; planned_finish: string | null; pct_complete: number; duration_days: number | null }>()).results;
  if (!rows.length) return null;
  const starts = rows.map((r) => r.planned_start).filter((s): s is string => !!s).sort();
  const finishes = rows.map((r) => r.planned_finish).filter((s): s is string => !!s).sort();
  if (!starts.length || !finishes.length) return null;
  const startMs = Date.parse(starts[0]), finishMs = Date.parse(finishes[finishes.length - 1]), asOfMs = Date.parse(asOf);
  if (isNaN(startMs) || isNaN(finishMs) || isNaN(asOfMs)) return null;
  const DAY = 86_400_000;
  const total_days = Math.max(1, Math.round((finishMs - startMs) / DAY));
  const day = Math.max(1, Math.min(total_days, Math.round((asOfMs - startMs) / DAY) + 1));
  // Duration-weighted % complete across leaf activities.
  let wsum = 0, w = 0;
  for (const r of rows) { const d = r.duration_days && r.duration_days > 0 ? r.duration_days : 1; wsum += (r.pct_complete || 0) * d; w += d; }
  const pct_overall = w > 0 ? Math.round((wsum / w) * 100) : 0;
  // Status: actual % vs % of the programme that should be done by now.
  const expected = Math.round((day / total_days) * 100);
  const variance = pct_overall - expected;
  const status = variance >= -2 ? "On programme" : variance >= -10 ? "Slightly behind" : "Behind programme";
  return { day, total_days, pct_overall, status };
}

export async function generateSiteReport(
  env: Env,
  args: { projectId: string; projectLabel: string; periodType: "daily" | "weekly"; start: string; end: string; actor: string },
): Promise<StoredReport> {
  const { projectId, projectLabel, periodType, start, end, actor } = args;
  const rows = await fetchUpdates(env, projectId, start, end);
  const sections = await summarise(env, buildTranscript(rows), { project: projectLabel, periodType, start, end, count: rows.length });
  // Recover any photos that came in but weren't saved (e.g. before photo-saving
  // was live, or served as octet-stream), then append the period's site photos.
  await backfillPeriodPhotos(env, projectId, start, end).catch(() => {});
  try {
    const ph = await env.DB.prepare(
      `SELECT file_key, file_type, caption FROM progress_photos
        WHERE project_id = ? AND substr(taken_on, 1, 10) BETWEEN ? AND ? ORDER BY id LIMIT 12`,
    ).bind(projectId, start, end).all<{ file_key: string; file_type: string | null; caption: string | null }>();
    const rows2 = ph.results;
    // AI vision describes the contents of each photo (first 8 to bound cost).
    const ai = await describePhotos(env, rows2.slice(0, 8));
    sections.photos = rows2.map((p, i) => ({
      url: `/api/operations/file?key=${encodeURIComponent(p.file_key)}`,
      // A human-written caption/comment always wins over the AI's guess; the AI
      // vision description only fills in when the photo carries no comment.
      caption: ((p.caption || "").trim() || ai[i] || ""),
    }));
  } catch { /* no photos / table absent */ }
  // Real weather for the site/period (geocoded from the project address) overrides
  // whatever was mentioned in the chat; keep the per-day breakdown for the charts.
  try { const w = await fetchWeather(env, projectId, start, end); if (w.summary) sections.weather = w.summary; sections.weather_days = w.days; } catch { /* keep chat value */ }
  // Headcount-by-day (sign-ins) and plant on site — data-backed sections.
  try { sections.labour_days = await labourDays(env, projectId, start, end); } catch { /* */ }
  try { sections.plant = await plantOnSite(env, projectId); } catch { /* */ }
  try { sections.programme = await programmeSummary(env, projectId, end); } catch { /* no programme imported */ }
  try { sections.attendance = await attendanceSummary(env, projectId, start, end); } catch { /* no sign-ins */ }
  try { sections.labour_table = await labourTable(env, projectId, start, end); } catch { /* */ }
  try { sections.deliveries_detail = await deliveriesDetail(env, projectId, start, end); } catch { /* */ }
  try { if (sections.safety) sections.safety.rams_outstanding = await ramsOutstanding(env, projectId); } catch { /* */ }
  const md = renderMarkdown(sections);
  const now = new Date().toISOString();
  await env.DB.prepare(
    "DELETE FROM site_reports WHERE project_id = ? AND period_type = ? AND period_start = ?",
  ).bind(projectId, periodType, start).run();
  const ins = await env.DB.prepare(
    `INSERT INTO site_reports (project_id, period_type, period_start, period_end, summary_md, data_json, update_count, status, generated_at, generated_by)
     VALUES (?,?,?,?,?,?,?,'generated',?,?) RETURNING *`,
  ).bind(projectId, periodType, start, end, md, JSON.stringify(sections), rows.length, now, actor).first<StoredReport>();
  return ins!;
}

// ── Email ──────────────────────────────────────────────────────────────────

const DEFAULT_FROM = "PowerGrid Reports <apps@notifications.powergridprojects.co.uk>";

function esc(s: string): string {
  return (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

function reportHtml(title: string, sub: string, sections: ReportSections): string {
  const block = (label: string, items: string[]) => items.length
    ? `<h3 style="margin:16px 0 4px;font-size:14px;color:#0f1130">${esc(label)}</h3><ul style="margin:0;padding-left:18px;font-size:13px;color:#222">${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`
    : "";
  const meta: string[] = [];
  if (sections.labour_count) meta.push(`<b>Labour on site:</b> ${esc(sections.labour_count)}`);
  if (sections.weather) meta.push(`<b>Weather:</b> ${esc(sections.weather)}`);
  if (sections.safety && (sections.safety.incidents || sections.safety.near_misses || sections.safety.toolbox_talks)) {
    meta.push(`<b>Safety:</b> ${sections.safety.incidents} inc · ${sections.safety.near_misses} near-miss · ${sections.safety.toolbox_talks} toolbox`);
  }
  const metaRow = meta.length
    ? `<p style="font-size:13px;color:#0f1130;background:#f1f5f9;padding:7px 10px;border-radius:6px;margin:0 0 12px">${meta.join("  &nbsp;·&nbsp;  ")}</p>` : "";
  const photos = sections.photos?.length
    ? `<h3 style="margin:16px 0 4px;font-size:14px;color:#0f1130">Photos (${sections.photos.length})</h3>
       <ul style="margin:0;padding-left:18px;font-size:13px;color:#222">${sections.photos.map((p) => `<li>${esc(p.caption || "Site photo")}</li>`).join("")}</ul>
       <p style="color:#6a6d8a;font-size:12px;margin:6px 0 0">Photos are attached to the report in the app and saved to the project's Site Photos.</p>` : "";
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:640px">
    <h2 style="font-size:18px;color:#0f1130;margin:0">${esc(title)}</h2>
    <p style="color:#6a6d8a;font-size:12px;margin:2px 0 12px">${esc(sub)}</p>
    ${metaRow}
    <p style="font-size:14px;font-weight:bold;color:#0f1130">${esc(sections.headline)}</p>
    ${SECTION_LABELS.map(([k, label]) => block(label, sections[k] as string[])).join("")}
    ${photos}
  </div>`;
}

/** Reply address for distributed reports — a reply here re-feeds the report (see
 *  handleReportReply). Cloudflare Email Routing must route this to the Worker. */
export const REPORT_REPLY_TO = "reports@pgpprojects.com";

export async function sendReportEmail(env: Env, to: string[], subject: string, html: string, replyTo?: string, attachments?: Array<{ filename: string; content: string }>): Promise<boolean> {
  if (!env.RESEND_API_KEY || to.length === 0) return false;
  const from = env.RESEND_FROM || DEFAULT_FROM;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.RESEND_API_KEY}` },
      body: JSON.stringify({ from, to, subject, html, ...(replyTo ? { reply_to: replyTo } : {}), ...(attachments?.length ? { attachments } : {}) }),
    });
    if (!res.ok) { console.error("report email failed", res.status, await res.text().catch(() => "")); return false; }
    return true;
  } catch (e) { console.error("report email error", e); return false; }
}

export async function recipientsFor(env: Env, projectId: string): Promise<string[]> {
  const p = await env.DB.prepare(
    "SELECT project_manager_email, site_manager_email, commercial_manager_email FROM projects WHERE id = ?",
  ).bind(projectId).first<{ project_manager_email: string | null; site_manager_email: string | null; commercial_manager_email: string | null }>();
  return [...new Set([p?.project_manager_email, p?.site_manager_email, p?.commercial_manager_email].filter((x): x is string => !!x))];
}

/** Current hour (0–23) / weekday (1=Mon..7=Sun) in UK local time — BST/GMT aware. */
export function londonHour(d: Date): number {
  return parseInt(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", hourCycle: "h23" }).format(d), 10);
}
export function londonWeekday(d: Date): number {
  const s = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short" }).format(d);
  return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(s) + 1;
}

type RuleRow = { id: number; project_id: string | null; frequency: string; format: string; recipients: string; only_if: string; send_time: string | null; include_managers: number };

/** Hour-of-day (0–23) a rule wants to send at; defaults to 7 (the morning run). */
function ruleHour(send_time: string | null): number {
  const m = /^\s*(\d{1,2})/.exec(send_time || "");
  const h = m ? parseInt(m[1], 10) : 7;
  return Number.isFinite(h) && h >= 0 && h <= 23 ? h : 7;
}

/** Auto-distribute: email this period's already-generated reports to any enabled
 *  rule whose send time falls in `hour`. Matches reports to rules by scope
 *  (project vs portfolio), so it covers standalone, group and roll-up reports
 *  without touching each generation path. Best-effort. Called hourly by the cron
 *  (see runDueDistributions) so each rule fires once a day at its chosen hour. */
async function distributeAll(env: Env, periodType: "daily" | "weekly", periodStart: string, hour: number): Promise<void> {
  let rules: RuleRow[];
  try {
    rules = (await env.DB.prepare(
      // content filter: hs_pack rules share this table (0109) — a weekly H&S
      // rule must never fire a site report at its recipients.
      `SELECT id, project_id, frequency, format, recipients, only_if, send_time, include_managers
         FROM distribution_rules
        WHERE enabled = 1 AND (frequency = ? OR frequency = 'both')
          AND content = 'report'`,
    ).bind(periodType).all<RuleRow>()).results;
  } catch (e) { console.warn("auto-distribute skipped (pre-0068?):", e instanceof Error ? e.message : e); return; }
  rules = rules.filter((r) => ruleHour(r.send_time) === hour);
  if (rules.length === 0) return;
  const reports = (await env.DB.prepare(
    `SELECT id, project_id, update_count, data_json FROM site_reports WHERE period_type = ? AND period_start = ?`,
  ).bind(periodType, periodStart).all<{ id: number; project_id: string | null; update_count: number; data_json: string | null }>()).results;
  const byProject = new Map<string | null, { id: number; update_count: number; data_json: string | null }>();
  for (const r of reports) byProject.set(r.project_id, r);
  const labelCache = new Map<string | null, string>();
  const labelFor = async (pid: string | null): Promise<string> => {
    if (labelCache.has(pid)) return labelCache.get(pid)!;
    let label = "Portfolio roll-up";
    if (pid) { const p = await env.DB.prepare("SELECT code, name FROM projects WHERE id = ?").bind(pid).first<{ code: string; name: string }>(); if (p) label = `${p.code} ${p.name}`; }
    labelCache.set(pid, label); return label;
  };
  const word = periodType === "weekly" ? "Weekly" : "Daily";
  const periodEnd = periodType === "weekly" ? weekBounds(periodStart).end : periodStart;
  const pdfCache = new Map<number, Array<{ filename: string; content: string }> | undefined>(); // render each report's PDF once
  for (const rule of rules) {
    const rep = byProject.get(rule.project_id);
    if (!rep) continue; // no report generated for this rule's scope this run
    if (rule.only_if === "skip_quiet" && (rep.update_count ?? 0) === 0) continue;
    let to: string[] = [];
    try { const v = JSON.parse(rule.recipients || "[]"); if (Array.isArray(v)) to = v.filter((x): x is string => typeof x === "string" && x.includes("@")); } catch { /* ignore */ }
    if (rule.include_managers && rule.project_id) {
      try { to = [...new Set([...to, ...(await recipientsFor(env, rule.project_id))])]; } catch { /* ignore */ }
    }
    if (to.length === 0) continue;
    const label = await labelFor(rule.project_id);
    const sections = JSON.parse(rep.data_json || "{}") as ReportSections;
    const title = `${word} site report · ${label}`;
    const sub = `${periodStart} · ${rep.update_count} update${rep.update_count === 1 ? "" : "s"}`;
    // [#id] lets a reply to reports@ be matched back to this report (handleReportReply).
    const subject = `${title} — ${periodStart} [#${rep.id}]`;
    if (!pdfCache.has(rep.id)) {
      const att = await reportPdfAttachment(env, { id: rep.id, project_id: rule.project_id, project_name: label, period_type: periodType, period_start: periodStart, period_end: periodEnd, data_json: rep.data_json, update_count: rep.update_count }, `${label} ${word} report ${periodStart}.pdf`);
      pdfCache.set(rep.id, att ? [att] : undefined);
    }
    const ok = await sendReportEmail(env, to, subject, reportHtml(title, sub, sections), REPORT_REPLY_TO, pdfCache.get(rep.id));
    if (ok) await env.DB.prepare("UPDATE site_reports SET status = 'sent' WHERE id = ?").bind(rep.id).run();
  }
}

/** A reply to a distributed report (to reports@) — re-feed it as a correction and
 *  rebuild the report so the amended version flows to the rest of the distribution
 *  list at their send time. Only internal (PowerGrid) senders may amend; the
 *  amender gets the corrected copy back. `body` should already be the top reply
 *  (quoted history stripped). Best-effort. */
export async function handleReportReply(env: Env, args: { subject: string; senderRaw: string; body: string }): Promise<void> {
  const m = /\[#(\d+)\]/.exec(args.subject || "");
  if (!m) { console.warn("report reply ignored — no [#id] token in subject"); return; }
  const reportId = parseInt(m[1], 10);
  const text = (args.body || "").trim();
  if (!text) return;
  const staff = args.senderRaw
    ? await env.DB.prepare("SELECT email FROM users WHERE lower(email) = ? AND active = 1").bind(args.senderRaw.toLowerCase()).first()
    : null;
  if (!staff) { console.warn("report reply ignored — sender not a PowerGrid user:", args.senderRaw); return; }
  const rep = await env.DB.prepare(
    "SELECT project_id, period_type, period_start, period_end FROM site_reports WHERE id = ?",
  ).bind(reportId).first<{ project_id: string | null; period_type: "daily" | "weekly"; period_start: string; period_end: string }>();
  if (!rep?.project_id) { console.warn("report reply ignored — report/project not found for", reportId); return; }
  const proj = await env.DB.prepare("SELECT code, name FROM projects WHERE id = ?").bind(rep.project_id).first<{ code: string; name: string }>();
  const label = `${proj?.code ?? ""} ${proj?.name ?? ""}`.trim();
  // Record the amendment inside the report's window, then rebuild from updates.
  await env.DB.prepare(
    "INSERT INTO project_updates (project_id, source, sender, body, occurred_at, created_at) VALUES (?, 'email-amend', ?, ?, ?, ?)",
  ).bind(rep.project_id, args.senderRaw, `Amendment: ${text}`, rep.period_start, new Date().toISOString()).run();
  const regen = await generateSiteReport(env, { projectId: rep.project_id, projectLabel: label, periodType: rep.period_type, start: rep.period_start, end: rep.period_end, actor: args.senderRaw });
  // Send the corrected copy back to the amender to confirm it landed.
  const word = rep.period_type === "weekly" ? "Weekly" : "Daily";
  const title = `${word} site report · ${label}`;
  const s = JSON.parse(regen.data_json || "{}") as ReportSections;
  await sendReportEmail(env, [args.senderRaw], `${title} — amended [#${regen.id}]`, reportHtml(title, `${rep.period_start} · amended just now`, s), REPORT_REPLY_TO);
}

/** Hourly cron tail: fire any enabled auto-distribute rule whose send time is the
 *  current hour, against the report generated in this morning's 07:00 run. Daily
 *  rules every day; weekly rules on Mondays (the day the weekly roll-up exists). */
export async function runDueDistributions(env: Env, hour: number): Promise<void> {
  const dailyStart = ymd(new Date(Date.now() - 86_400_000));
  await distributeAll(env, "daily", dailyStart, hour);
  if (londonWeekday(new Date()) === 1) await distributeAll(env, "weekly", weekBounds(dailyStart).start, hour);
}

// ── Cron runners ─────────────────────────────────────────────────────────────

/** Active (non-deleted, non-complete) projects that logged ≥1 update in the range. */
async function projectsWithUpdates(env: Env, start: string, end: string): Promise<Array<{ id: string; code: string; name: string }>> {
  const r = await env.DB.prepare(
    `SELECT DISTINCT p.id, p.code, p.name FROM project_updates u
       JOIN projects p ON p.id = u.project_id
      WHERE p.deleted_at IS NULL AND p.id <> 'sandbox' AND substr(u.occurred_at, 1, 10) BETWEEN ? AND ?
      ORDER BY p.code`,
  ).bind(start, end).all<{ id: string; code: string; name: string }>();
  return r.results;
}

type RepProj = { id: string; code: string; name: string };

/** Split updated projects into site groups (≥1 updated member; carries ALL members
 *  for the per-block detail) vs standalone projects. Grouped blocks share one
 *  physical site, so they get ONE combined report. */
async function partitionByGroup(
  env: Env, updated: RepProj[],
): Promise<{ groups: Array<{ id: string; name: string; members: RepProj[]; updatedIds: Set<string> }>; standalone: RepProj[] }> {
  if (!updated.length) return { groups: [], standalone: [] };
  const ph = updated.map(() => "?").join(",");
  let gidByProj = new Map<string, string | null>();
  try {
    const rows = (await env.DB.prepare(`SELECT id, site_group_id FROM projects WHERE id IN (${ph})`)
      .bind(...updated.map((p) => p.id)).all<{ id: string; site_group_id: string | null }>()).results;
    gidByProj = new Map(rows.map((r) => [r.id, r.site_group_id]));
  } catch { /* pre-grouping schema — treat all as standalone */ }
  const standalone: RepProj[] = [];
  const updByGroup = new Map<string, RepProj[]>();
  for (const p of updated) {
    const gid = gidByProj.get(p.id) ?? null;
    if (!gid) standalone.push(p);
    else { const a = updByGroup.get(gid) ?? []; a.push(p); updByGroup.set(gid, a); }
  }
  const groups: Array<{ id: string; name: string; members: RepProj[]; updatedIds: Set<string> }> = [];
  for (const [gid, upd] of updByGroup) {
    const g = await env.DB.prepare("SELECT name FROM site_groups WHERE id = ?").bind(gid).first<{ name: string }>();
    const members = (await env.DB.prepare(
      "SELECT id, code, name FROM projects WHERE site_group_id = ? AND deleted_at IS NULL ORDER BY code",
    ).bind(gid).all<RepProj>()).results;
    if (members.length <= 1) { standalone.push(...upd); continue; } // a "group" of one → treat as standalone
    groups.push({ id: gid, name: g?.name ?? `${upd[0].code} site`, members, updatedIds: new Set(upd.map((x) => x.id)) });
  }
  return { groups, standalone };
}

/** A member's sections for the period — reuse the stored row if present, else
 *  generate + store it. Returns the section data + the report row id. */
async function memberSections(
  env: Env, p: RepProj, periodType: "daily" | "weekly", start: string, end: string, actor: string,
): Promise<{ sections: ReportSections; reportId: number }> {
  const existing = await env.DB.prepare(
    "SELECT id, data_json FROM site_reports WHERE project_id = ? AND period_type = ? AND period_start = ?",
  ).bind(p.id, periodType, start).first<{ id: number; data_json: string | null }>();
  if (existing?.data_json) {
    try { return { sections: JSON.parse(existing.data_json) as ReportSections, reportId: existing.id }; } catch { /* regen */ }
  }
  const rep = await generateSiteReport(env, { projectId: p.id, projectLabel: `${p.code} ${p.name}`, periodType, start, end, actor });
  return { sections: JSON.parse(rep.data_json || "{}") as ReportSections, reportId: rep.id };
}

/** Build + send ONE combined report for a site group, to the union of every
 *  block's managers. Returns each updated block's sections (for the weekly
 *  portfolio roll-up). */
async function sendGroupReport(
  env: Env, group: { id: string; name: string; members: RepProj[]; updatedIds: Set<string> },
  periodType: "daily" | "weekly", start: string, end: string, actor: string,
): Promise<Array<{ code: string; name: string; sections: ReportSections }>> {
  // Generate each updated block's report row only — distribution (managers +
  // clients) is driven by the per-project rules, so no email is sent here.
  const built = new Map<string, { sections: ReportSections; reportId: number }>();
  for (const m of group.members) {
    if (!group.updatedIds.has(m.id)) continue;
    built.set(m.id, await memberSections(env, m, periodType, start, end, actor));
  }
  if (built.size === 0) return [];
  return group.members.filter((m) => built.has(m.id)).map((m) => ({ code: m.code, name: m.name, sections: built.get(m.id)!.sections }));
}

/** Make sure every active project carries a "Project managers" distribution rule
 *  (managers-included, daily + weekly, 07:00) — covers projects added after the
 *  0069 seed and the site-group blocks. Idempotent; runs each morning. */
async function ensureManagerRules(env: Env): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO distribution_rules (project_id, name, frequency, format, recipients, send_time, only_if, enabled, include_managers, created_at, created_by)
       SELECT p.id, 'Project managers', 'both', 'pdf_link', '[]', '07:00', 'always', 1, 1, ?, 'system'
         FROM projects p
        WHERE p.deleted_at IS NULL AND p.id <> 'sandbox'
          AND NOT EXISTS (SELECT 1 FROM distribution_rules dr WHERE dr.project_id = p.id AND dr.include_managers = 1 AND dr.content = 'report')`,
    ).bind(new Date().toISOString()).run();
  } catch (e) { console.warn("ensureManagerRules skipped:", e instanceof Error ? e.message : e); }
}

/** Daily job — generate yesterday's report for each standalone project and each
 *  site-group block (silently); distribution is driven by the rules. */
export async function runDailyReports(env: Env): Promise<void> {
  await ensureManagerRules(env);
  const start = ymd(new Date(Date.now() - 86_400_000));
  const end = start;
  let projects: RepProj[];
  try { projects = await projectsWithUpdates(env, start, end); }
  catch (e) { console.warn("daily reports skipped (pre-0051?):", e instanceof Error ? e.message : e); return; }
  const { groups, standalone } = await partitionByGroup(env, projects);
  for (const g of groups) {
    try { await sendGroupReport(env, g, "daily", start, end, "cron"); }
    catch (e) { console.warn(`daily group report failed for ${g.name}:`, e instanceof Error ? e.message : e); }
  }
  for (const p of standalone) {
    try {
      // Generate only — distribution (to managers + clients) is driven by the rules.
      await generateSiteReport(env, { projectId: p.id, projectLabel: `${p.code} ${p.name}`, periodType: "daily", start, end, actor: "cron" });
    } catch (e) { console.warn(`daily report failed for ${p.code}:`, e instanceof Error ? e.message : e); }
  }
}

/** Combine per-project report sections into one portfolio roll-up section set:
 *  a headline per site, with HSE / blockers / safety aggregated across all. */
function buildPortfolioSections(
  perProject: Array<{ code: string; name: string; sections: ReportSections }>,
  periodType: "daily" | "weekly",
  start: string,
): ReportSections {
  const when = periodType === "weekly" ? `this week (w/c ${start})` : `on ${start}`;
  return {
    headline: `${perProject.length} active site${perProject.length === 1 ? "" : "s"} reported ${when}.`,
    labour_count: "", weather: "",
    progress: perProject.map((p) => `${p.code} ${p.name}: ${p.sections.headline}`),
    deliveries: [], labour: [],
    hse: perProject.flatMap((p) => (p.sections.hse ?? []).map((h) => `${p.code}: ${h}`)),
    blockers: perProject.flatMap((p) => (p.sections.blockers ?? []).map((b) => `${p.code}: ${b}`)),
    lookahead: [], photos: [],
    weather_days: [], labour_days: [], plant: [],
    safety: {
      incidents: perProject.reduce((n, p) => n + (p.sections.safety?.incidents ?? 0), 0),
      near_misses: perProject.reduce((n, p) => n + (p.sections.safety?.near_misses ?? 0), 0),
      toolbox_talks: perProject.reduce((n, p) => n + (p.sections.safety?.toolbox_talks ?? 0), 0),
    },
  };
}

/**
 * On-demand portfolio roll-up: one combined report (project_id NULL) across every
 * active project with field updates in the period. Reuses each project's existing
 * report for the period when present, otherwise generates it. Returns the row.
 */
export async function generatePortfolioReport(
  env: Env,
  args: { periodType: "daily" | "weekly"; start: string; end: string; actor: string },
): Promise<StoredReport> {
  const { periodType, start, end, actor } = args;
  const projects = await projectsWithUpdates(env, start, end);
  if (projects.length === 0) {
    throw new Error("No field updates were logged on any project for that period — nothing to roll up.");
  }
  const perProject: Array<{ code: string; name: string; sections: ReportSections }> = [];
  let totalUpdates = 0;
  for (const p of projects) {
    let sections: ReportSections | null = null;
    const existing = await env.DB.prepare(
      "SELECT data_json, update_count FROM site_reports WHERE project_id = ? AND period_type = ? AND period_start = ?",
    ).bind(p.id, periodType, start).first<{ data_json: string | null; update_count: number }>();
    if (existing?.data_json) {
      try { sections = JSON.parse(existing.data_json) as ReportSections; totalUpdates += existing.update_count ?? 0; } catch { /* fall through to regenerate */ }
    }
    if (!sections) {
      const rep = await generateSiteReport(env, { projectId: p.id, projectLabel: `${p.code} ${p.name}`, periodType, start, end, actor });
      sections = JSON.parse(rep.data_json || "{}") as ReportSections;
      totalUpdates += rep.update_count ?? 0;
    }
    perProject.push({ code: p.code, name: p.name, sections });
  }
  const portfolio = buildPortfolioSections(perProject, periodType, start);
  const now = new Date().toISOString();
  await env.DB.prepare(
    "DELETE FROM site_reports WHERE project_id IS NULL AND period_type = ? AND period_start = ?",
  ).bind(periodType, start).run();
  const ins = await env.DB.prepare(
    `INSERT INTO site_reports (project_id, period_type, period_start, period_end, summary_md, data_json, update_count, status, generated_at, generated_by)
     VALUES (NULL, ?, ?, ?, ?, ?, ?, 'generated', ?, ?) RETURNING *`,
  ).bind(periodType, start, end, renderMarkdown(portfolio), JSON.stringify(portfolio), totalUpdates, now, actor).first<StoredReport>();
  return ins!;
}

/** Weekly job — last Mon–Sun per project, plus a portfolio roll-up. Run on Mondays. */
export async function runWeeklyReports(env: Env): Promise<void> {
  const { start, end } = weekBounds(ymd(new Date(Date.now() - 86_400_000))); // last week (yesterday was Sun)
  let projects: RepProj[];
  try { projects = await projectsWithUpdates(env, start, end); }
  catch (e) { console.warn("weekly reports skipped:", e instanceof Error ? e.message : e); return; }
  const { groups, standalone } = await partitionByGroup(env, projects);
  const perProject: Array<{ code: string; name: string; sections: ReportSections }> = [];
  for (const g of groups) {
    try { perProject.push(...await sendGroupReport(env, g, "weekly", start, end, "cron")); }
    catch (e) { console.warn(`weekly group report failed for ${g.name}:`, e instanceof Error ? e.message : e); }
  }
  for (const p of standalone) {
    try {
      // Generate only — distribution is driven by the rules; collect for the roll-up.
      const rep = await generateSiteReport(env, { projectId: p.id, projectLabel: `${p.code} ${p.name}`, periodType: "weekly", start, end, actor: "cron" });
      perProject.push({ code: p.code, name: p.name, sections: JSON.parse(rep.data_json || "{}") as ReportSections });
    } catch (e) { console.warn(`weekly report failed for ${p.code}:`, e instanceof Error ? e.message : e); }
  }
  // Portfolio roll-up — one combined report (project_id NULL), headline per project.
  if (perProject.length) {
    const portfolio = buildPortfolioSections(perProject, "weekly", start);
    const now = new Date().toISOString();
    await env.DB.prepare("DELETE FROM site_reports WHERE project_id IS NULL AND period_type = 'weekly' AND period_start = ?").bind(start).run();
    await env.DB.prepare(
      `INSERT INTO site_reports (project_id, period_type, period_start, period_end, summary_md, data_json, update_count, status, generated_at, generated_by)
       VALUES (NULL,'weekly',?,?,?,?,?, 'generated', ?, 'cron')`,
    ).bind(start, end, renderMarkdown(portfolio), JSON.stringify(portfolio), perProject.length, now).run();
  }
}

// ── Authenticated API ────────────────────────────────────────────────────────

/** List recent reports (optionally filtered by project / period type). */
siteReports.get("/", async (c) => {
  const project = c.req.query("project");
  const period = c.req.query("period");
  const conds: string[] = []; const binds: unknown[] = [];
  if (project) {
    // Accept a comma-separated list so a site group can pull every block's
    // reports in one call (the group Reports tab labels each row by block).
    const ids = project.split(",").map((s) => s.trim()).filter(Boolean);
    if (ids.length === 1) { conds.push("r.project_id = ?"); binds.push(ids[0]); }
    else if (ids.length > 1) { conds.push(`r.project_id IN (${ids.map(() => "?").join(",")})`); binds.push(...ids); }
  }
  if (period) { conds.push("r.period_type = ?"); binds.push(period); }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  try {
    const r = await c.env.DB.prepare(
      `SELECT r.id, r.project_id, r.period_type, r.period_start, r.period_end, r.update_count,
              r.status, r.generated_at, p.code AS project_code, p.name AS project_name,
              EXISTS(SELECT 1 FROM project_updates pu
                      WHERE (r.project_id IS NULL OR pu.project_id = r.project_id)
                        AND pu.source NOT IN ('manual', 'email', 'dronedeploy')
                        AND substr(pu.occurred_at, 1, 10) BETWEEN r.period_start AND r.period_end) AS from_whatsapp
         FROM site_reports r LEFT JOIN projects p ON p.id = r.project_id
         ${where}
        ORDER BY r.period_start DESC, r.period_type, p.code
        LIMIT 200`,
    ).bind(...binds).all();
    return c.json(r.results);
  } catch { return c.json([]); }
});

/** Per-project WhatsApp connection status — which active projects have had a
 *  WhatsApp chat matched to them (any source='whatsapp' update), the chat name,
 *  last message and recent volume. Registered before "/:id" so it isn't matched
 *  as a report id. */
siteReports.get("/whatsapp-status", async (c) => {
  const denied = requirePermission(c, "delivery.edit");
  if (denied) return denied;
  const db = c.env.DB;
  const week = new Date(Date.now() - 7 * 86_400_000).toISOString();
  let projects: Array<{ id: string; code: string; name: string }> = [];
  try {
    projects = (await db.prepare(
      "SELECT id, code, name FROM projects WHERE deleted_at IS NULL AND completed_at IS NULL ORDER BY code",
    ).all<{ id: string; code: string; name: string }>()).results;
  } catch { projects = []; }
  void week;
  const stat = new Map<string, { wa_count: number; email_count: number; last_at: string | null; group_name: string | null }>();
  try {
    // Feeds = WhatsApp + email (exclude manual logs and DroneDeploy). Split the
    // counts so the UI can show WhatsApp vs email separately; last_at is the most
    // recent of either feed; connected = we've had at least one WhatsApp message.
    const rows = await db.prepare(
      `SELECT pu.project_id AS pid,
              SUM(CASE WHEN pu.source NOT IN ('manual', 'email', 'dronedeploy') THEN 1 ELSE 0 END) AS wa_count,
              SUM(CASE WHEN pu.source = 'email' THEN 1 ELSE 0 END) AS email_count,
              MAX(pu.occurred_at) AS last_at,
              (SELECT u2.group_name FROM project_updates u2
                WHERE u2.project_id = pu.project_id AND u2.source NOT IN ('manual', 'email', 'dronedeploy') AND u2.group_name IS NOT NULL
                ORDER BY u2.occurred_at DESC LIMIT 1) AS group_name
         FROM project_updates pu
        WHERE pu.source NOT IN ('manual', 'dronedeploy')
        GROUP BY pu.project_id`,
    ).all<{ pid: string; wa_count: number; email_count: number; last_at: string | null; group_name: string | null }>();
    for (const r of rows.results) stat.set(r.pid, { wa_count: r.wa_count, email_count: r.email_count, last_at: r.last_at, group_name: r.group_name });
  } catch { /* project_updates table may be absent */ }
  // Explicit group→project links (Connect a group): a linked project reads as
  // connected and shows its group name even before its first message arrives.
  const links = new Map<string, string | null>();
  try {
    const lr = await db.prepare("SELECT project_id, group_name FROM whatsapp_group_links").all<{ project_id: string; group_name: string | null }>();
    for (const r of lr.results) links.set(r.project_id, r.group_name);
  } catch { /* table absent before migration 0057 */ }
  return c.json(projects.map((p) => {
    const s = stat.get(p.id);
    const wa = s?.wa_count ?? 0, email = s?.email_count ?? 0;
    return {
      project_id: p.id, code: p.code, name: p.name,
      connected: wa > 0 || links.has(p.id),
      group_name: s?.group_name ?? links.get(p.id) ?? null,
      last_at: s?.last_at ?? null,
      wa_count: wa, email_count: email, updates: wa + email,
    };
  }));
});

/**
 * Ask Whapi for the WhatsApp groups this number is in (id, subject, member
 * count, and — best-effort from /chats — last-message time). Returns
 * configured:false when no token is set so the UI can fall back to the manual
 * helper. Never throws: any failure resolves to connected:false + an error.
 */
async function whapiGroups(env: Env): Promise<{
  configured: boolean; connected: boolean; error?: string;
  groups: Array<{ chat_id: string; name: string; members: number | null; last_at: string | null }>;
}> {
  const token = env.WHAPI_TOKEN;
  if (!token) return { configured: false, connected: false, groups: [] };
  const base = (env.WHAPI_BASE_URL || "https://gate.whapi.cloud").replace(/\/+$/, "");
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  try {
    const r = await fetch(`${base}/groups?count=500`, { headers });
    if (!r.ok) return { configured: true, connected: false, groups: [], error: `Whapi /groups returned ${r.status}` };
    const j = await r.json() as Record<string, unknown>;
    const raw = (Array.isArray((j as { groups?: unknown }).groups) ? (j as { groups: unknown[] }).groups : Array.isArray(j) ? (j as unknown[]) : []) as Array<Record<string, unknown>>;
    const num = (v: unknown) => (typeof v === "number" ? v : null);
    const groups = raw.map((g) => ({
      chat_id: String(g.id ?? g.chat_id ?? g.group_id ?? ""),
      name: String(g.name ?? g.subject ?? g.chat_name ?? "").trim(),
      members: Array.isArray(g.participants) ? (g.participants as unknown[]).length : (num(g.size) ?? num(g.participants_count)),
      last_at: null as string | null,
    })).filter((g) => g.chat_id);
    // Best-effort last-message time from /chats, matched by id.
    try {
      const rc = await fetch(`${base}/chats?count=500`, { headers });
      if (rc.ok) {
        const jc = await rc.json() as { chats?: Array<Record<string, unknown>> };
        const tmap = new Map<string, number>();
        for (const ch of (jc.chats ?? [])) {
          const id = String(ch.id ?? "");
          const lm = ch.last_message as { timestamp?: unknown } | undefined;
          const t = ch.timestamp ?? lm?.timestamp ?? ch.t;
          if (id && t != null && /^\d+$/.test(String(t))) tmap.set(id, Number(t));
        }
        for (const g of groups) { const t = tmap.get(g.chat_id); if (t) g.last_at = new Date(t < 1e12 ? t * 1000 : t).toISOString(); }
      }
    } catch { /* last-message is optional */ }
    return { configured: true, connected: true, groups };
  } catch (e) {
    return { configured: true, connected: false, groups: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/** Live list of WhatsApp groups (via Whapi) not yet linked to a project, each
 *  with a suggested project match (project code as a token in the chat name). */
siteReports.get("/whatsapp-groups", async (c) => {
  const denied = requirePermission(c, "delivery.edit");
  if (denied) return denied;
  const db = c.env.DB;
  const projects = (await db.prepare(
    "SELECT id, code, name FROM projects WHERE deleted_at IS NULL AND completed_at IS NULL ORDER BY code",
  ).all<{ id: string; code: string; name: string }>()).results;
  const linked = new Set<string>();
  try { const lr = await db.prepare("SELECT chat_id FROM whatsapp_group_links").all<{ chat_id: string }>(); for (const r of lr.results) linked.add(r.chat_id); } catch { /* table absent pre-0057 */ }
  const wa = await whapiGroups(c.env);
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const suggest = (name: string) => {
    const lc = name.toLowerCase();
    for (const p of projects) {
      const code = String(p.code).toLowerCase().trim();
      if (code && new RegExp(`(^|[^a-z0-9])${esc(code)}([^a-z0-9]|$)`).test(lc)) return { project_id: p.id, code: p.code, name: p.name };
    }
    return null;
  };
  const detected = wa.groups
    .filter((g) => !linked.has(g.chat_id))
    .map((g) => ({ ...g, suggested: suggest(g.name) }))
    .sort((a, b) => (a.suggested ? 0 : 1) - (b.suggested ? 0 : 1) || a.name.localeCompare(b.name));
  return c.json({ configured: wa.configured, connected: wa.connected, error: wa.error ?? null, groups: detected });
});

/** Link a WhatsApp group to a project — future messages route by this chat_id,
 *  and any past chatter under the same chat name is re-pointed to the project. */
siteReports.post("/whatsapp-groups/link", async (c) => {
  const denied = requirePermission(c, "delivery.edit");
  if (denied) return denied;
  const body = await c.req.json<{ chat_id?: string; group_name?: string; project_id?: string }>().catch(() => ({} as { chat_id?: string; group_name?: string; project_id?: string }));
  const chat_id = (body.chat_id ?? "").trim();
  const project_id = (body.project_id ?? "").trim();
  const group_name = (body.group_name ?? "").trim() || null;
  if (!chat_id || !project_id) return c.json({ error: "chat_id and project_id are required" }, 400);
  const proj = await c.env.DB.prepare("SELECT id FROM projects WHERE id = ?").bind(project_id).first<{ id: string }>();
  if (!proj) return c.json({ error: "project not found" }, 404);
  const now = new Date().toISOString();
  const actor = c.get("userEmail");
  await c.env.DB.prepare(
    `INSERT INTO whatsapp_group_links (chat_id, project_id, group_name, linked_at, linked_by)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET project_id = excluded.project_id, group_name = excluded.group_name, linked_at = excluded.linked_at, linked_by = excluded.linked_by`,
  ).bind(chat_id, project_id, group_name, now, actor).run();
  // Re-point any past WhatsApp updates from this group (matched by chat name) so
  // historical chatter counts toward the now-linked project.
  let rerouted = 0;
  if (group_name) {
    const res = await c.env.DB.prepare(
      "UPDATE project_updates SET project_id = ? WHERE group_name = ? AND project_id != ? AND source NOT IN ('manual','email','dronedeploy')",
    ).bind(project_id, group_name, project_id).run();
    rerouted = res.meta?.changes ?? 0;
  }
  return c.json({ ok: true, rerouted });
});

/** Unfiled project emails (couldn't be auto-matched to a project) awaiting
 *  manual allocation — the correspondence tray shown on Reports. */
siteReports.get("/correspondence", async (c) => {
  const denied = requirePermission(c, "delivery.edit");
  if (denied) return denied;
  try {
    const r = await c.env.DB.prepare(
      "SELECT id, sender, subject, body, received_at FROM inbound_correspondence WHERE status = 'pending' ORDER BY received_at DESC LIMIT 50",
    ).all<{ id: number; sender: string; subject: string; body: string; received_at: string }>();
    return c.json(r.results);
  } catch { return c.json([]); /* table absent pre-0058 */ }
});

/** Allocate an unfiled email to a project — files it as an email update so it
 *  flows into that project's reports, and marks the tray item handled. */
siteReports.post("/correspondence/:id/allocate", async (c) => {
  const denied = requirePermission(c, "delivery.edit");
  if (denied) return denied;
  const id = c.req.param("id");
  const body = await c.req.json<{ project_id?: string }>().catch(() => ({} as { project_id?: string }));
  const project_id = (body.project_id ?? "").trim();
  if (!project_id) return c.json({ error: "project_id is required" }, 400);
  const row = await c.env.DB.prepare(
    "SELECT id, sender, body, received_at FROM inbound_correspondence WHERE id = ? AND status = 'pending'",
  ).bind(id).first<{ id: number; sender: string; body: string; received_at: string }>();
  if (!row) return c.json({ error: "not found or already handled" }, 404);
  const proj = await c.env.DB.prepare("SELECT id FROM projects WHERE id = ?").bind(project_id).first<{ id: string }>();
  if (!proj) return c.json({ error: "project not found" }, 404);
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO project_updates (project_id, source, external_id, group_name, sender, body, media_url, occurred_at, created_at)
     VALUES (?, 'email', ?, 'Client correspondence', ?, ?, NULL, ?, ?)`,
  ).bind(project_id, `corr-${row.id}:${project_id}`, row.sender, row.body, row.received_at, now).run();
  await c.env.DB.prepare(
    "UPDATE inbound_correspondence SET status = 'allocated', project_id = ?, allocated_at = ?, allocated_by = ? WHERE id = ?",
  ).bind(project_id, now, c.get("userEmail"), id).run();
  return c.json({ ok: true });
});

/** Dismiss an unfiled email (not project-related). */
siteReports.post("/correspondence/:id/dismiss", async (c) => {
  const denied = requirePermission(c, "delivery.edit");
  if (denied) return denied;
  await c.env.DB.prepare(
    "UPDATE inbound_correspondence SET status = 'dismissed', allocated_at = ?, allocated_by = ? WHERE id = ? AND status = 'pending'",
  ).bind(new Date().toISOString(), c.get("userEmail"), c.req.param("id")).run();
  return c.json({ ok: true });
});

// ── Auto-distribute rules (registered before /:id so the path isn't mistaken
//    for a report id) ──────────────────────────────────────────────────────────
siteReports.get("/distribution-rules", async (c) => {
  const denied = requirePermission(c, "delivery.edit");
  if (denied) return denied;
  try {
    const rows = await c.env.DB.prepare(
      `SELECT r.id, r.project_id, r.name, r.frequency, r.format, r.recipients, r.send_time, r.only_if, r.enabled, r.include_managers,
              r.content, r.weekday, r.last_sent_at,
              p.code AS project_code, p.name AS project_name
         FROM distribution_rules r LEFT JOIN projects p ON p.id = r.project_id
        ORDER BY r.content DESC, r.created_at DESC`,
    ).all();
    return c.json(rows.results);
  } catch { return c.json([]); }
});

/** Normalise a rule body for its kind. hs_pack rules (the H&S pack release,
 *  unified here by 0109) are per-project, weekly|monthly, always full-PDF. */
function ruleShape(b: { content?: string; project_id?: string | null; frequency?: string; format?: string; only_if?: string; weekday?: number | null }) {
  const content = b.content === "hs_pack" ? "hs_pack" : "report";
  if (content === "hs_pack") {
    return {
      content,
      frequency: b.frequency === "monthly" ? "monthly" : "weekly",
      format: "pdf", only_if: "always",
      weekday: Math.min(7, Math.max(1, Math.round(Number(b.weekday) || 1))),
    };
  }
  return { content, frequency: b.frequency ?? "daily", format: b.format ?? "pdf_link", only_if: b.only_if ?? "always", weekday: null };
}

siteReports.post("/distribution-rules", async (c) => {
  const denied = requirePermission(c, "delivery.edit");
  if (denied) return denied;
  const b = await c.req.json<{ project_id?: string | null; name?: string; content?: string; frequency?: string; format?: string; recipients?: string[]; send_time?: string; only_if?: string; enabled?: boolean; include_managers?: boolean; weekday?: number | null }>();
  const s = ruleShape(b);
  if (s.content === "hs_pack" && !b.project_id) return c.json({ error: "An H&S pack rule needs a project — packs are per-site." }, 400);
  const recipients = JSON.stringify((b.recipients ?? []).filter((x) => typeof x === "string" && x.includes("@")));
  const r = await c.env.DB.prepare(
    `INSERT INTO distribution_rules (project_id, name, content, frequency, format, recipients, send_time, weekday, only_if, enabled, include_managers, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  ).bind(
    b.project_id ?? null, b.name?.trim() || (s.content === "hs_pack" ? "H&S pack" : null), s.content, s.frequency, s.format,
    recipients, b.send_time ?? "07:30", s.weekday, s.only_if, b.enabled === false ? 0 : 1, b.include_managers ? 1 : 0,
    new Date().toISOString(), c.get("userEmail"),
  ).first();
  return c.json(r);
});

siteReports.put("/distribution-rules/:id", async (c) => {
  const denied = requirePermission(c, "delivery.edit");
  if (denied) return denied;
  const b = await c.req.json<{ project_id?: string | null; name?: string; content?: string; frequency?: string; format?: string; recipients?: string[]; send_time?: string; only_if?: string; enabled?: boolean; include_managers?: boolean; weekday?: number | null }>();
  const s = ruleShape(b);
  if (s.content === "hs_pack" && !b.project_id) return c.json({ error: "An H&S pack rule needs a project — packs are per-site." }, 400);
  const recipients = JSON.stringify((b.recipients ?? []).filter((x) => typeof x === "string" && x.includes("@")));
  await c.env.DB.prepare(
    `UPDATE distribution_rules SET project_id=?, name=?, content=?, frequency=?, format=?, recipients=?, send_time=?, weekday=?, only_if=?, enabled=?, include_managers=? WHERE id=?`,
  ).bind(
    b.project_id ?? null, b.name?.trim() || (s.content === "hs_pack" ? "H&S pack" : null), s.content, s.frequency, s.format,
    recipients, b.send_time ?? "07:30", s.weekday, s.only_if, b.enabled === false ? 0 : 1, b.include_managers ? 1 : 0, c.req.param("id"),
  ).run();
  return c.json({ ok: true });
});

siteReports.delete("/distribution-rules/:id", async (c) => {
  const denied = requirePermission(c, "delivery.edit");
  if (denied) return denied;
  await c.env.DB.prepare("DELETE FROM distribution_rules WHERE id = ?").bind(c.req.param("id")).run();
  return c.json({ ok: true });
});

/** One report with its full content. */
siteReports.get("/:id", async (c) => {
  const denied = requirePermission(c, "delivery.edit");
  if (denied) return denied;
  const r = await c.env.DB.prepare(
    `SELECT r.*, p.code AS project_code, p.name AS project_name
       FROM site_reports r LEFT JOIN projects p ON p.id = r.project_id WHERE r.id = ?`,
  ).bind(c.req.param("id")).first();
  if (!r) return c.json({ error: "not found" }, 404);
  return c.json(r);
});

/** Raw updates feeding a project + date range (so the UI can show the source). */
siteReports.get("/:projectId/updates", async (c) => {
  const denied = requirePermission(c, "delivery.edit");
  if (denied) return denied;
  const start = c.req.query("start") || ymd(new Date());
  const end = c.req.query("end") || start;
  try {
    const rows = await c.env.DB.prepare(
      `SELECT id, source, sender, body, media_url, occurred_at FROM project_updates
        WHERE project_id = ? AND substr(occurred_at,1,10) BETWEEN ? AND ? ORDER BY occurred_at`,
    ).bind(c.req.param("projectId"), start, end).all();
    return c.json(rows.results);
  } catch { return c.json([]); }
});

/** Manually log an update (lets you test the pipeline before WhatsApp is wired). */
siteReports.post("/:projectId/updates", async (c) => {
  const denied = requirePermission(c, "delivery.edit");
  if (denied) return denied;
  const b = await c.req.json<{ body: string; sender?: string; occurred_at?: string }>();
  if (!b.body?.trim()) return c.json({ error: "body required" }, 400);
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO project_updates (project_id, source, sender, body, occurred_at, created_at)
     VALUES (?, 'manual', ?, ?, ?, ?)`,
  ).bind(c.req.param("projectId"), b.sender?.trim() || c.get("userEmail"), b.body.trim(), b.occurred_at || now, now).run();
  return c.json({ ok: true });
});

/** Generate a report on demand (in-app button). date = any day in the period. */
siteReports.post("/generate", async (c) => {
  const denied = requirePermission(c, "delivery.edit");
  if (denied) return denied;
  const b = await c.req.json<{ project_id: string; period_type: "daily" | "weekly"; date?: string }>();
  if (!b.project_id || (b.period_type !== "daily" && b.period_type !== "weekly")) {
    return c.json({ error: "project_id and period_type (daily|weekly) required" }, 400);
  }
  const date = b.date || ymd(new Date());
  const { start, end } = b.period_type === "weekly" ? weekBounds(date) : { start: date, end: date };
  // "__portfolio__" → a combined roll-up across every active site (project_id NULL).
  if (b.project_id === "__portfolio__") {
    try {
      const rep = await generatePortfolioReport(env(c), { periodType: b.period_type, start, end, actor: c.get("userEmail") });
      return c.json(rep);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "generation failed" }, 500);
    }
  }
  const p = await c.env.DB.prepare("SELECT code, name FROM projects WHERE id = ?").bind(b.project_id).first<{ code: string; name: string }>();
  if (!p) return c.json({ error: "project not found" }, 404);
  try {
    const rep = await generateSiteReport(env(c), { projectId: b.project_id, projectLabel: `${p.code} ${p.name}`, periodType: b.period_type, start, end, actor: c.get("userEmail") });
    return c.json(rep);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "generation failed" }, 500);
  }
});

/** Email an existing report to the project's managers (or explicit recipients). */
// All of a report period's site photos — the pool the report drawer's photo
// picker chooses from (so managers can add ones the auto-pick missed, e.g. Blyth).
siteReports.get("/:id/photos", async (c) => {
  const denied = requirePermission(c, "delivery.edit");
  if (denied) return denied;
  const r = await c.env.DB.prepare("SELECT project_id, period_start, period_end FROM site_reports WHERE id = ?")
    .bind(c.req.param("id")).first<{ project_id: string | null; period_start: string; period_end: string }>();
  if (!r) return c.json({ error: "not found" }, 404);
  if (!r.project_id) return c.json([]);
  try {
    const rows = (await c.env.DB.prepare(
      `SELECT id, file_key, caption, taken_on FROM progress_photos
         WHERE project_id = ? AND substr(taken_on, 1, 10) BETWEEN ? AND ? ORDER BY id`,
    ).bind(r.project_id, r.period_start, r.period_end).all<{ id: number; file_key: string; caption: string | null; taken_on: string }>()).results;
    return c.json(rows.map((p) => ({ id: p.id, url: `/api/operations/file?key=${encodeURIComponent(p.file_key)}`, caption: p.caption || "", taken_on: p.taken_on })));
  } catch { return c.json([]); }
});

// Save the curated photo set (+ optional captions) onto the report — persists to
// data_json so the drawer, PDF and auto-distribute all use the chosen photos.
siteReports.patch("/:id/photos", async (c) => {
  const denied = requirePermission(c, "delivery.edit");
  if (denied) return denied;
  const b = await c.req.json<{ photos?: Array<{ url: string; caption?: string }> }>().catch(() => ({ photos: [] }));
  const photos = (b.photos ?? []).filter((p) => p && typeof p.url === "string").map((p) => ({ url: p.url, caption: (p.caption ?? "").trim() }));
  const r = await c.env.DB.prepare("SELECT data_json FROM site_reports WHERE id = ?").bind(c.req.param("id")).first<{ data_json: string | null }>();
  if (!r) return c.json({ error: "not found" }, 404);
  let sections: Record<string, unknown>;
  try { sections = JSON.parse(r.data_json || "{}"); } catch { sections = {}; }
  sections.photos = photos;
  await c.env.DB.prepare("UPDATE site_reports SET data_json = ? WHERE id = ?").bind(JSON.stringify(sections), c.req.param("id")).run();
  return c.json({ ok: true, count: photos.length });
});

// Save an edited report — the drawer's "Edit" mode sends back the whole sections
// object (edited headline / bullets / look-ahead), persisted to data_json so the
// change sticks in the drawer, the PDF and the auto-distribute emails.
siteReports.patch("/:id", async (c) => {
  const denied = requirePermission(c, "delivery.edit");
  if (denied) return denied;
  const b = await c.req.json<{ sections?: Record<string, unknown> }>().catch(() => ({ sections: undefined }));
  if (!b.sections || typeof b.sections !== "object") return c.json({ error: "sections required" }, 400);
  const r = await c.env.DB.prepare("SELECT id FROM site_reports WHERE id = ?").bind(c.req.param("id")).first();
  if (!r) return c.json({ error: "not found" }, 404);
  await c.env.DB.prepare("UPDATE site_reports SET data_json = ? WHERE id = ?").bind(JSON.stringify(b.sections), c.req.param("id")).run();
  return c.json({ ok: true });
});

siteReports.get("/:id/pdf", async (c) => {
  const denied = requirePermission(c, "delivery.edit");
  if (denied) return denied;
  const r = await c.env.DB.prepare(
    `SELECT r.*, p.code AS project_code, p.name AS project_name FROM site_reports r
       LEFT JOIN projects p ON p.id = r.project_id WHERE r.id = ?`,
  ).bind(c.req.param("id")).first<StoredReport & { project_code: string | null; project_name: string | null }>();
  if (!r) return c.json({ error: "not found" }, 404);
  const pdf = await renderReportPdf(c.env, { id: r.id, project_id: r.project_id, project_code: r.project_code, project_name: r.project_name, period_type: r.period_type as "daily" | "weekly", period_start: r.period_start, period_end: r.period_end, data_json: r.data_json, update_count: r.update_count, generated_by: r.generated_by });
  if (!pdf) return c.json({ error: "PDF unavailable — Browser Rendering not active" }, 503);
  const label = r.project_id ? `${r.project_code ?? ""} ${r.project_name ?? ""}`.trim() : "Portfolio";
  const fn = `${label} report ${r.period_start}.pdf`.replace(/[\\/]/g, "-");
  return new Response(pdf as unknown as BodyInit, { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${fn}"` } });
});

siteReports.post("/:id/send", async (c) => {
  const denied = requirePermission(c, "delivery.edit");
  if (denied) return denied;
  const body = await c.req.json<{ to?: string[] }>().catch(() => ({ to: undefined }));
  const r = await c.env.DB.prepare(
    `SELECT r.*, p.code AS project_code, p.name AS project_name FROM site_reports r
       LEFT JOIN projects p ON p.id = r.project_id WHERE r.id = ?`,
  ).bind(c.req.param("id")).first<StoredReport & { project_code: string | null; project_name: string | null }>();
  if (!r) return c.json({ error: "not found" }, 404);
  // Sandbox/demo report: mark as sent so the demo flow completes, but never
  // actually email anyone (even if explicit recipients were passed).
  if (isSandboxId(r.project_id)) {
    await c.env.DB.prepare("UPDATE site_reports SET status = 'sent' WHERE id = ?").bind(r.id).run();
    return c.json({ ok: true, sandbox: true, sent_to: [], note: "Sandbox project — email not actually sent." });
  }
  const to = (body.to && body.to.length) ? body.to : (r.project_id ? await recipientsFor(c.env, r.project_id) : []);
  if (to.length === 0) return c.json({ error: "no recipients — set the project's manager emails or pass to[]" }, 400);
  const sections = JSON.parse(r.data_json || "{}") as ReportSections;
  const label = r.project_id ? `${r.project_code} ${r.project_name}` : "Portfolio";
  const title = `${r.period_type === "daily" ? "Daily" : "Weekly"} site report · ${label}`;
  const sub = r.period_type === "daily" ? `${r.period_start} · ${r.update_count} updates` : `${r.period_start} to ${r.period_end} · ${r.update_count} updates`;
  const rfp: ReportForPdf = { id: r.id, project_id: r.project_id, project_code: r.project_code, project_name: r.project_name, period_type: r.period_type as "daily" | "weekly", period_start: r.period_start, period_end: r.period_end, data_json: r.data_json, update_count: r.update_count, generated_by: r.generated_by };
  const attach = await reportPdfAttachment(c.env, rfp, `${label} report ${r.period_start}.pdf`);
  const ok = await sendReportEmail(c.env, to, `${title} — ${r.period_start} [#${r.id}]`, reportHtml(title, sub, sections), REPORT_REPLY_TO, attach ? [attach] : undefined);
  if (!ok) return c.json({ error: "email not sent — RESEND_API_KEY may be unset" }, 502);
  await c.env.DB.prepare("UPDATE site_reports SET status = 'sent' WHERE id = ?").bind(r.id).run();
  return c.json({ ok: true, sent_to: to, pdf: !!attach });
});

// Hono context env accessor (keeps generateSiteReport call above tidy).
function env(c: { env: Env }): Env { return c.env; }
