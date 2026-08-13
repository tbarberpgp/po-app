// Inbound-email handler — receives mail forwarded to apps@pgpprojects.com via
// Cloudflare Email Routing, identifies the project + subcontractor, pulls the
// XLSX/PDF attachment, and creates a draft incoming_labour AfP with the
// matched lines pre-populated. Replies to the sender with success or an
// actionable error.
//
// Workflow:
//   1. Parse the inbound MIME (postal-mime). Pull from / subject / attachments.
//   2. Match the sender's email DOMAIN against any labour supplier's
//      contact_email domain. Any address on that domain counts (so any team
//      member of the subbie can email — not just the registered contact).
//   3. Find a project code in the subject (e.g. MCR007, 26001) and resolve it
//      to a projects.id.
//   4. For each XLSX/PDF attachment call processLabourAppUpload to create a
//      draft AfP.
//   5. Send a confirmation/error reply via Resend.
//
// The Worker is bound to an inbound email address via Cloudflare's Email
// Routing → "Send to a Worker" route. The address (apps@<domain>) is set up
// once in the Cloudflare dashboard.

import PostalMime from "postal-mime";
import type { Env } from "./env";
import { extractLabourLines, extractCertificateLines, createAfpFromLines, applyClientCertificate, putLabourSourceFile, setAfpSourceFile, setAfpCertFile, sha256Hex, findDuplicateSourceDoc, extractCombinedLabourByProject, resolveCombinedGroupBase, createCombinedClientAfpFromLines } from "./routes/applications";
import { ingestInvoice } from "./routes/invoices";
import type { ExtractedLabourLine } from "./routes/applications";
import { handleReportReply } from "./routes/site-reports";

/** First reply paragraph only — drop quoted history ("On … wrote:", "> …", etc.). */
function topReply(text: string): string {
  const out: string[] = [];
  for (const ln of (text || "").split(/\r?\n/)) {
    const t = ln.trim();
    if (/^>/.test(t)) break;
    if (/^On\b.*\bwrote:?\s*$/i.test(t)) break;
    if (/^-{2,}\s*(original message|forwarded message)\s*-{2,}/i.test(t)) break;
    if (out.length && /^(from|sent|to|subject):\s/i.test(t)) break;
    out.push(ln);
  }
  return out.join("\n").trim();
}

/** Cloudflare's ForwardableEmailMessage isn't bundled with our types; this is
 *  the subset of the interface we touch. See:
 *  https://developers.cloudflare.com/email-routing/email-workers/runtime-api/  */
type ForwardableEmailMessage = {
  from: string;
  to: string;
  raw: ReadableStream;
  rawSize: number;
  setReject(reason: string): void;
  headers: Headers;
};

/** Escape a string for safe use inside a RegExp. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type ResolvedProject = { id: string; code: string; name: string };

/**
 * Resolve which project an email is for by matching the actual project codes
 * in the DB against the email text. Returns the project, or "none" / "ambiguous".
 * Matches whole tokens (word boundaries) case-insensitively so "26001" hits
 * but "260012" or a phone number won't. Prefers subject/filename over body.
 */
async function resolveProject(
  env: Env,
  text: { primary: string; body: string },
): Promise<ResolvedProject | "none" | "ambiguous"> {
  const projects = await env.DB.prepare(
    "SELECT id, code, name FROM projects WHERE deleted_at IS NULL",
  ).all<ResolvedProject>();
  if (projects.results.length === 0) return "none";

  const matchesIn = (haystack: string): ResolvedProject[] => {
    const lc = haystack.toLowerCase();
    const seen = new Map<string, ResolvedProject>();
    for (const p of projects.results) {
      const code = String(p.code).trim();
      if (!code) continue;
      const re = new RegExp(`(^|[^a-z0-9])${escapeRegex(code.toLowerCase())}([^a-z0-9]|$)`);
      if (re.test(lc)) seen.set(p.id, p);
    }
    return [...seen.values()];
  };

  // High-confidence sources first.
  let hits = matchesIn(text.primary);
  if (hits.length === 0) hits = matchesIn(`${text.primary}  ${text.body}`);

  if (hits.length === 0) return "none";
  if (hits.length > 1) return "ambiguous";
  return hits[0];
}

/** Lowercase the part after the @ sign. Empty string if there's no @. */
function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1).trim().toLowerCase() : "";
}

/** Pull the first email address from a "Name <addr@host>"-style string. */
function bareAddress(s: string): string {
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim().toLowerCase();
}

/** All email addresses found in a blob of text, lowercased, de-duped, in order. */
function emailsInText(text: string): string[] {
  const re = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(re)) {
    const e = m[0].toLowerCase();
    if (!seen.has(e)) { seen.add(e); out.push(e); }
  }
  return out;
}

type LabourSupplier = { id: number; name: string; contact_email: string | null };

/** Find a labour supplier whose contact_email is on the given domain. */
async function supplierByDomain(env: Env, domain: string): Promise<LabourSupplier | null> {
  if (!domain) return null;
  return env.DB.prepare(
    `SELECT id, name, contact_email FROM suppliers
     WHERE is_labour_supplier = 1 AND contact_email IS NOT NULL
       AND lower(contact_email) LIKE ?`,
  ).bind(`%@${domain}`).first<LabourSupplier>();
}

/**
 * For a PM-forwarded email, work out which subcontractor the application is
 * from. Two strategies, in order of reliability:
 *   1. Scan the forwarded body for any email address whose domain matches a
 *      labour supplier (the subbie's original message is quoted in the forward).
 *   2. Fuzzy-match labour-supplier names against the subject line.
 * Returns null if neither finds a confident single match.
 */
async function detectForwardedSupplier(
  env: Env,
  bodyText: string,
  subject: string,
  pgDomains: Set<string>,
): Promise<LabourSupplier | null> {
  // Strategy 1 — domains in the body (skip PG's own + common mail providers).
  for (const email of emailsInText(bodyText)) {
    const d = domainOf(email);
    if (!d || pgDomains.has(d)) continue;
    const s = await supplierByDomain(env, d);
    if (s) return s;
  }

  // Strategy 2 — supplier name appears in the subject. Require the supplier's
  // distinctive first word (≥4 chars) to appear, and exactly one supplier to hit.
  const subjectLc = subject.toLowerCase();
  const labour = await env.DB.prepare(
    "SELECT id, name, contact_email FROM suppliers WHERE is_labour_supplier = 1",
  ).all<LabourSupplier>();
  const hits = labour.results.filter((s) => {
    const firstWord = s.name.toLowerCase().split(/\s+/).find((w) => w.length >= 4);
    return firstWord ? subjectLc.includes(firstWord) : false;
  });
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Cloudflare Email Routing runs SPF/DKIM/DMARC on inbound mail and records the
 * verdicts in an Authentication-Results header. A `From` spoofed to look like a
 * PowerGrid staff member (which would otherwise unlock client-application
 * submission and payment-certificate processing) yields `dmarc=fail` when the
 * spoofed domain publishes DMARC. We only DOWNGRADE trust on an explicit
 * `dmarc=fail` — DMARC survives forwarding (unlike raw SPF), and a domain with no
 * DMARC record reports `dmarc=none`, so legitimate mail is never blocked.
 */
function senderDmarcFailed(message: ForwardableEmailMessage): boolean {
  try {
    const ar = message.headers.get("authentication-results") || "";
    return /\bdmarc\s*=\s*fail\b/i.test(ar);
  } catch { return false; }
}

export async function handleInboundEmail(
  message: ForwardableEmailMessage,
  env: Env,
  opts: { noReply?: boolean } = {},
): Promise<void> {
  // When the message was PULLED from a company mailbox via Graph (rather than
  // delivered to us directly), suppress every auto-reply — the original sender
  // emailed the company inbox, not us, so we must not email them back.
  const noReply = opts.noReply === true;
  const senderRaw = bareAddress(message.from);
  const senderDomain = domainOf(senderRaw);

  // ── 1. Parse the MIME message ────────────────────────────────────────
  let parsed;
  try {
    parsed = await PostalMime.parse(message.raw);
  } catch (e) {
    console.error("Inbound email parse failed", e);
    return;
  }

  const subject = (parsed.subject ?? "").trim();
  const attachments = (parsed.attachments ?? []).filter((a) => {
    const name = (a.filename ?? "").toLowerCase();
    return (
      a.mimeType === "application/pdf" ||
      a.mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      a.mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      name.endsWith(".pdf") || name.endsWith(".xlsx") || name.endsWith(".xls") || name.endsWith(".docx")
    );
  });

  // ── Direction from the recipient address ─────────────────────────────
  // clientapps@ → outgoing (PG → client); anything else (labourapps@,
  // applications@, apps@) → incoming labour (subcontractor → PG).
  const recipientLocal = bareAddress(message.to).split("@")[0] ?? "";

  // ── Report amendments — reports@pgpprojects.com ─────────────────────────
  // A reply to a distributed site report. The [#id] in the subject ties it back
  // to the report; the reply is re-fed as a correction and the report rebuilt,
  // so the amended version reaches the rest of the distribution list.
  if (/^reports?$/i.test(recipientLocal)) {
    await handleReportReply(env, { subject, senderRaw, body: topReply(parsed.text ?? "") });
    return;
  }

  // ── Accounts inbox — invoices@pgpprojects.com ───────────────────────────
  // Supplier invoices/bills. Each PDF/image attachment is stored, read by
  // Claude, and dropped into the Accounts inbox for coding + Xero push.
  if (/^invoices?$/i.test(recipientLocal)) {
    const invoiceFiles = (parsed.attachments ?? []).filter((a) => {
      const n = (a.filename ?? "").toLowerCase();
      const looksFile = a.mimeType === "application/pdf" || /^image\//.test(a.mimeType ?? "")
        || n.endsWith(".pdf") || /\.(png|jpe?g|gif|webp)$/.test(n);
      if (!looksFile) return false;
      const isPdf = a.mimeType === "application/pdf" || n.endsWith(".pdf");
      if (isPdf) return true;
      // Signature/body images ride along on every forwarded email — inline or
      // cid-referenced parts are decoration, and anything under ~25KB is a
      // logo, not a photographed invoice.
      const rec = a as unknown as { disposition?: string | null; related?: boolean };
      if (rec.related === true || rec.disposition === "inline") return false;
      const size = a.content instanceof ArrayBuffer ? a.content.byteLength : (a.content as Uint8Array).byteLength;
      return size >= 25_000;
    });
    if (invoiceFiles.length === 0) {
      if (!noReply) await sendErrorReply(env, senderRaw, subject, "We received your email but found no PDF or image invoice attached. Please attach the invoice and resend.");
      return;
    }
    for (const att of invoiceFiles) {
      try {
        const buf = att.content instanceof ArrayBuffer ? att.content : new Uint8Array(att.content as Uint8Array).buffer;
        const r = await ingestInvoice(env, {
          file: { buffer: buf, name: att.filename ?? "invoice.pdf", type: att.mimeType ?? "" },
          source: "email", sender: senderRaw, subject, actor: senderRaw,
        });
        if (r.skipped) console.log(`invoice attachment skipped (${r.skipped}):`, att.filename ?? "?");
      } catch (e) { console.error("invoice ingest failed:", e instanceof Error ? e.message : e); }
    }
    return;
  }

  // ── Client correspondence dropbox — projects@pgpprojects.com ────────────
  // CC'd on every email to the client. Scans the message for the project it
  // relates to and stores it as a project update, so it flows straight into
  // the daily/weekly site reports alongside WhatsApp + manual updates.
  // Checked FIRST so the aliases can't fall through to the other flows.
  if (/^(projects?|record|cc|copy|correspondence|clientmail)$/i.test(recipientLocal)) {
    await ingestClientCorrespondence(env, parsed, senderRaw, subject);
    return;
  }

  const direction: "outgoing" | "incoming_labour" =
    /client/i.test(recipientLocal) ? "outgoing" : "incoming_labour";

  // Is the sender a PowerGrid user? (used by both flows) — only trust the From
  // when the message wasn't flagged as a DMARC spoof, since staff status unlocks
  // client-application submission and payment-certificate processing.
  const isPgStaff = (senderRaw && !senderDmarcFailed(message))
    ? !!(await env.DB.prepare("SELECT email FROM users WHERE lower(email) = ? AND active = 1")
        .bind(senderRaw).first())
    : false;

  // ── Payment certificate (clientcerts@ / labourcerts@) ────────────────
  // A returned application annotated with certified figures, forwarded by a
  // PowerGrid PM. clientcerts@ (recipient contains "client") certifies our
  // outgoing client application; any other "cert" address (labourcerts@,
  // certs@) certifies the newest submitted incoming-labour application. Both
  // lock the certified figures (submitted → certified).
  if (/cert/i.test(recipientLocal)) {
    const certBody = { text: parsed.text ?? null, html: parsed.html ?? null };
    if (direction === "outgoing") {
      await handleClientCertificate(env, { senderRaw, subject, attachments, isPgStaff, body: certBody });
    } else {
      await handleLabourCertificate(env, { senderRaw, senderDomain, subject, attachments, isPgStaff, body: certBody });
    }
    return;
  }

  // ── 2. Resolve the counterparty ──────────────────────────────────────
  let supplier: LabourSupplier | null = null;
  let supplierUnresolvedForward = false;

  if (direction === "outgoing") {
    // Client applications are PG documents → only PowerGrid staff may submit.
    // The counterparty (client) is implicit from the project; no supplier.
    if (!isPgStaff) {
      console.warn(`clientapps email rejected: sender not PG staff`, { from: senderRaw, subject });
      if (!noReply) await sendErrorReply(env, senderRaw, subject,
        `Client applications can only be submitted by PowerGrid staff. Your address (${senderRaw}) ` +
        `isn't a registered PowerGrid user — ask an admin to add your account.`);
      return;
    }
  } else {
    // Incoming labour:
    //   A — sender's domain is a labour supplier (subbie sent direct)
    //   B — sender is PowerGrid staff: it's a forward, detect the subbie
    //   C — unknown sender → reject
    supplier = await supplierByDomain(env, senderDomain);
    if (!supplier) {
      if (isPgStaff) {
        const pgDomains = new Set<string>([senderDomain].filter(Boolean));
        const body = `${parsed.text ?? ""}\n${parsed.html ?? ""}`;
        supplier = await detectForwardedSupplier(env, body, subject, pgDomains);
        if (!supplier) supplierUnresolvedForward = true;   // create draft, PM assigns later
      } else {
        console.warn(`labourapps email rejected: unknown sender`, { from: senderRaw, subject });
        if (!noReply) await sendErrorReply(env, senderRaw, subject,
          `Your email address (${senderRaw}) isn't a registered labour supplier or a PowerGrid user. ` +
          `If you're a subcontractor, ask your PowerGrid PM to add your business email domain on the ` +
          `Approved Suppliers page. If you're PowerGrid staff, ask an admin to add your account.`);
        return;
      }
    }
  }

  // ── 3. Need an attachment regardless of project resolution ───────────
  if (attachments.length === 0) {
    if (!noReply) await sendErrorReply(env, senderRaw, subject,
      `We received your email but no PDF, Word (.docx) or XLSX attachment was found. Please attach the application and resend.`);
    return;
  }

  // ── 4. Project code → project (may be unresolved) ────────────────────
  // Match against the REAL project codes in the DB (not a blind pattern), so
  // a stray 5-digit number in a signature can't false-match. Search the
  // subject + attachment filenames first; if nothing hits, fall back to body.
  // If we can't resolve a single project we DON'T reject — we extract the
  // lines and park the application in the inbound tray for manual assignment.
  const projectResult = await resolveProject(env, {
    primary: [subject, ...attachments.map((a) => a.filename ?? "")].join("  "),
    body: `${parsed.text ?? ""}\n${parsed.html ?? ""}`,
  });
  const project = (projectResult === "none" || projectResult === "ambiguous") ? null : projectResult;

  // ── 5. Per attachment: extract → create draft OR park in inbound tray ─
  const created: Array<{ file: string; afp_id: number; app_number: number; extracted: number; matched: number; unmatched: number }> = [];
  const parked: Array<{ file: string; lines: number }> = [];
  const failed: Array<{ file: string; error: string }> = [];
  const duplicates: Array<{ file: string; afp_id: number | null; app_number: number | null; status: string; project_code: string | null }> = [];

  const periodEnd = new Date().toISOString().slice(0, 10);
  const kind = direction === "outgoing" ? "client application" : "labour application";
  const inboundNote = supplierUnresolvedForward
    ? `Forwarded by ${senderRaw} — subject "${subject}". Subcontractor not auto-detected — please assign on the draft.`
    : `Received ${kind} via email from ${senderRaw} — subject "${subject}".`;

  for (const att of attachments) {
    const fname = att.filename ?? "application.xlsx";
    try {
      const buf = att.content instanceof ArrayBuffer
        ? att.content
        : new Uint8Array(att.content as Uint8Array).buffer;

      // Duplicate document? A re-forward of a PDF that's already an application
      // (or already parked) must not mint a shadow draft — skip it and say so
      // in the reply. Hash match = byte-identical file.
      try {
        const hash = await sha256Hex(buf);
        const dupe = await findDuplicateSourceDoc(env, hash);
        if (dupe) {
          duplicates.push(dupe.where === "afp"
            ? { file: fname, afp_id: dupe.id, app_number: dupe.app_number, status: dupe.status, project_code: dupe.project_code }
            : { file: fname, afp_id: null, app_number: null, status: "awaiting assignment", project_code: null });
          continue;
        }
      } catch { /* pre-0110 DB or hash failure — never block ingest on dedupe */ }

      // A COMBINED client workbook (one tab per block, named by project code —
      // e.g. "26001-2-3 … Application 2.xlsx") must go through the combined
      // path: one AfP on the group's base carrying every block's BOQ. Parsed
      // as a single-project application it lands on whichever block the
      // filename matches with the wrong figures entirely.
      if (direction === "outgoing" && /\.xlsx?$/.test(fname.toLowerCase())) {
        let byProject: Array<{ code: string; lines: ExtractedLabourLine[] }> = [];
        try { byProject = extractCombinedLabourByProject(buf); } catch { /* not a combined workbook */ }
        if (byProject.length >= 2) {
          try {
            const baseProjectId = await resolveCombinedGroupBase(env, byProject.map((b) => b.code));
            const r = await createCombinedClientAfpFromLines(env, {
              baseProjectId,
              periodEnd,
              notes: inboundNote,
              perBlock: byProject.map((b) => ({ code: b.code, extracted: b.lines })),
              actor: `email:${senderRaw}`,
            });
            await setAfpSourceFile(env, r.id, await putLabourSourceFile(env, { buffer: buf, name: fname, type: att.mimeType ?? "" })).catch(() => {});
            created.push({ file: fname, afp_id: r.id, app_number: r.app_number, extracted: r.extracted_count, matched: r.matched_count, unmatched: r.unmatched_count });
            continue;
          } catch (e) {
            // Tabs found but the group/BOQ didn't resolve — fall through to the
            // single-project path rather than dropping the application.
            console.warn("combined client ingest fell back to single-project:", e instanceof Error ? e.message : e);
          }
        }
      }

      let appMeta: import("./routes/applications").LabourAppMeta | null = null;
      const extracted: ExtractedLabourLine[] = await extractLabourLines(env, {
        buffer: buf, name: fname, type: att.mimeType ?? "",
      }, (m) => { appMeta = m; });
      const appMetaJson = appMeta && Object.values(appMeta).some((v) => v != null) ? JSON.stringify(appMeta) : null;

      // Keep the source file in R2 so it can attach to the Xero bill later —
      // whether the draft is created now or parked and resolved later.
      const sourceFile = await putLabourSourceFile(env, { buffer: buf, name: fname, type: att.mimeType ?? "" }).catch(() => null);

      if (project) {
        // Project known — create the draft straight away.
        const result = await createAfpFromLines(env, {
          projectId: project.id,
          direction,
          counterpartySupplierId: supplier?.id ?? null,
          periodEnd,
          notes: inboundNote,
          extracted,
          actor: `email:${senderRaw}`,
        });
        if (sourceFile) await setAfpSourceFile(env, result.id, sourceFile).catch(() => {});
        if (appMetaJson) await env.DB.prepare("UPDATE applications_for_payment SET extracted_meta_json = ? WHERE id = ?").bind(appMetaJson, result.id).run().catch(() => {});
        created.push({
          file: fname, afp_id: result.id, app_number: result.app_number,
          extracted: result.extracted_count, matched: result.matched_count, unmatched: result.unmatched_count,
        });
      } else {
        // Project unknown — park in the inbound tray for manual assignment. The
        // stored file key rides along and is set on the AfP when it's resolved.
        await env.DB.prepare(
          `INSERT INTO inbound_applications
             (received_at, sender_email, subject, filename, direction, counterparty_supplier_id,
              extracted_lines_json, status, note, source_file_key, source_file_name, source_file_type, source_file_hash, extracted_meta_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
        ).bind(
          new Date().toISOString(), senderRaw, subject || null, fname, direction,
          supplier?.id ?? null, JSON.stringify(extracted),
          projectResult === "ambiguous" ? "Multiple project codes found in the email" : "No project code found",
          sourceFile?.key ?? null, sourceFile?.name ?? null, sourceFile?.type ?? null, sourceFile?.hash ?? null, appMetaJson,
        ).run();
        parked.push({ file: fname, lines: extracted.length });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      failed.push({ file: fname, error: msg });
      // Never lose a document: even a failed extraction parks in the inbound
      // tray with the source file and the error, so it's visible in the app
      // and can be opened / resolved rather than silently vanishing.
      try {
        const buf2 = att.content instanceof ArrayBuffer ? att.content : new Uint8Array(att.content as Uint8Array).buffer;
        const sf = await putLabourSourceFile(env, { buffer: buf2, name: fname, type: att.mimeType ?? "" }).catch(() => null);
        await env.DB.prepare(
          `INSERT INTO inbound_applications
             (received_at, sender_email, subject, filename, direction, counterparty_supplier_id,
              extracted_lines_json, status, note, source_file_key, source_file_name, source_file_type, source_file_hash)
           VALUES (?, ?, ?, ?, ?, NULL, '[]', 'pending', ?, ?, ?, ?, ?)`,
        ).bind(new Date().toISOString(), senderRaw, subject || null, fname, direction,
          `Extraction failed: ${msg}`.slice(0, 300), sf?.key ?? null, sf?.name ?? null, sf?.type ?? null, sf?.hash ?? null).run();
      } catch { /* parking is best-effort */ }
    }
  }

  // ── 6. Reply ─────────────────────────────────────────────────────────
  if (!noReply) await sendOutcomeReply(env, senderRaw, subject, {
    direction, project, supplier, created, parked, failed, duplicates,
    supplierUnresolved: supplierUnresolvedForward,
  });
}

/**
 * record@/cc@/copy@/clientmail@ flow — a dropbox CC'd on every email to the
 * client. Works out which project(s) the email concerns (project code in the
 * subject/body/recipients is the strong signal; a unique project-name mention
 * is the fallback) and files it as a project update, so it appears in that
 * project's daily and weekly site reports alongside WhatsApp/manual updates.
 */
async function ingestClientCorrespondence(
  env: Env,
  parsed: Awaited<ReturnType<typeof PostalMime.parse>>,
  senderRaw: string,
  subject: string,
): Promise<void> {
  const stripHtml = (h: string) => h.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const text = (parsed.text ?? stripHtml(parsed.html ?? "")).trim();
  const recipients = [...(parsed.to ?? []), ...(parsed.cc ?? [])]
    .map((a) => `${("name" in a ? a.name : "") ?? ""} ${("address" in a ? a.address : "") ?? ""}`)
    .join(" ");
  const corpus = `${subject}\n${text}\n${recipients}`;

  const projects = (await env.DB.prepare(
    "SELECT id, code, name FROM projects WHERE deleted_at IS NULL",
  ).all<{ id: string; code: string; name: string }>()).results;

  // Strong signal: the project code (e.g. 26001) as a number token. Allow a
  // letter suffix — internal job refs append one (e.g. "25008AN", "25007CL") —
  // but reject adjacent digits so 26001 doesn't match inside 260012.
  let matched = projects.filter((p) =>
    p.code && new RegExp(`(?<![0-9])${escapeRe(p.code)}(?![0-9])`, "i").test(corpus));
  // Fallback: exactly one project whose name appears verbatim.
  if (matched.length === 0) {
    const nameHits = projects.filter((p) =>
      (p.name ?? "").length >= 6 && corpus.toLowerCase().includes(p.name.toLowerCase()));
    if (nameHits.length === 1) matched = nameHits;
  }
  // A forward carries the content we want BELOW the "Forwarded message" header,
  // so trimming at "From:" (right for a CC'd reply) would throw it away. Detect
  // forwards and keep the forwarded body; otherwise keep just the fresh reply.
  const isForward = /^\s*(fwd|fw)\s*:/i.test(subject) || /-{2,}\s*forwarded message\s*-{2,}/i.test(text);
  const cleanSubject = subject.replace(/^(\s*(fwd|fw|re)\s*:\s*)+/i, "").trim();
  const fresh = (isForward
    ? text
        .replace(/-{2,}\s*forwarded message\s*-{2,}/i, "")
        .split(/\r?\n/)
        .filter((l) => !/^\s*>/.test(l) && !/^\s*(from|date|sent|subject|to|cc|reply-to)\s*:/i.test(l))
        .join("\n")
    : text
        .split(/\r?\n/).filter((l) => !/^\s*>/.test(l)).join("\n")
        .split(/\n-{2,}\s*Original Message|\nOn .{0,100}wrote:|\nFrom: /i)[0]
  ).replace(/\s+/g, " ").trim();
  const excerpt = fresh.length > 700 ? fresh.slice(0, 699) + "…" : fresh;
  const body = `Project email — “${cleanSubject || "(no subject)"}”${excerpt ? `: ${excerpt}` : ""}`;

  const baseId = (parsed.messageId ?? `${subject}|${parsed.date ?? ""}`).slice(0, 200);
  const occurredAt = parsed.date ? new Date(parsed.date).toISOString() : new Date().toISOString();
  const now = new Date().toISOString();
  if (matched.length === 0) {
    // No project code/name match — park in the correspondence tray for manual
    // allocation in Reports (covers code-less subcontractor threads), rather
    // than dropping it. INSERT OR IGNORE on message_id-derived dedupe.
    try {
      await env.DB.prepare(
        `INSERT INTO inbound_correspondence (message_id, sender, subject, body, received_at, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      ).bind(parsed.messageId ?? null, senderRaw || "unknown", cleanSubject || subject || "(no subject)", body, occurredAt, now).run();
      console.log("client-correspondence parked for allocation", { from: senderRaw, subject });
    } catch (e) { console.warn("client-correspondence: tray insert failed (pre-0058?)", e instanceof Error ? e.message : e); }
    return;
  }
  for (const p of matched) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO project_updates
         (project_id, source, external_id, group_name, sender, body, media_url, occurred_at, created_at)
       VALUES (?, 'email', ?, 'Client correspondence', ?, ?, NULL, ?, ?)`,
    ).bind(p.id, `${baseId}:${p.id}`, senderRaw || "unknown", body, occurredAt, now).run();
  }
  console.log(`client-correspondence stored → ${matched.map((m) => m.code).join(", ")}`, { subject });
}

/**
 * clientcerts@ flow — apply a client's returned payment certificate to the
 * newest submitted outgoing application for the project. Forwarded by a
 * PowerGrid PM (the client emails the PM, who forwards here), so the sender
 * must be PG staff. Matched by project code, then the certified figures are
 * locked onto the application (submitted → certified). Unlike the new-draft
 * flows, an unresolved certificate is NOT parked — it's bounced back asking
 * for the project code — because parking would create a new draft rather than
 * certify the existing application.
 */
async function handleClientCertificate(
  env: Env,
  args: {
    senderRaw: string;
    subject: string;
    attachments: Array<{ filename?: string | null; mimeType?: string | null; content: unknown }>;
    isPgStaff: boolean;
    body: { text: string | null; html: string | null };
  },
): Promise<void> {
  const { senderRaw, subject, attachments, isPgStaff, body } = args;

  if (!isPgStaff) {
    console.warn("clientcerts email rejected: sender not PG staff", { from: senderRaw, subject });
    await sendErrorReply(env, senderRaw, subject,
      `Client payment certificates can only be forwarded by PowerGrid staff. Your address (${senderRaw}) ` +
      `isn't a registered PowerGrid user — ask an admin to add your account.`);
    return;
  }

  if (attachments.length === 0) {
    await sendErrorReply(env, senderRaw, subject,
      `We received your email but no PDF, Word (.docx) or XLSX certificate was attached. Please attach the client's certificate and resend.`);
    return;
  }

  const projectResult = await resolveProject(env, {
    primary: [subject, ...attachments.map((a) => a.filename ?? "")].join("  "),
    body: `${body.text ?? ""}\n${body.html ?? ""}`,
  });
  if (projectResult === "none" || projectResult === "ambiguous") {
    await sendErrorReply(env, senderRaw, subject,
      projectResult === "ambiguous"
        ? `We found more than one project code in your email, so we couldn't tell which application this certifies. ` +
          `Please forward again with a single project code in the subject (e.g. "26001").`
        : `We couldn't find a project code in your email, so we couldn't match this certificate to an application. ` +
          `Please forward again with the project code in the subject (e.g. "26001").`);
    return;
  }
  const project = projectResult;

  const applied: Array<{ file: string; afp_id: number; app_number: number; certified_amount: number; matched: number; lines: number; unmatched: number }> = [];
  const noTarget: string[] = [];
  const failed: Array<{ file: string; error: string }> = [];

  for (const att of attachments) {
    const fname = att.filename ?? "certificate.xlsx";
    try {
      const raw = att.content as ArrayBuffer | Uint8Array;
      const buf = raw instanceof ArrayBuffer ? raw : new Uint8Array(raw).buffer;
      const extracted: ExtractedLabourLine[] = await extractCertificateLines(env, {
        buffer: buf, name: fname, type: att.mimeType ?? "",
      });
      const result = await applyClientCertificate(env, {
        projectId: project.id,
        extracted,
        actor: `email:${senderRaw}`,
      });
      if (!result) { noTarget.push(fname); continue; }
      // Keep the certificate itself on the AfP — it's the paper behind the
      // now-locked certified figures.
      await setAfpCertFile(env, result.id, { buffer: buf, name: fname, type: att.mimeType ?? "" }).catch(() => {});
      applied.push({
        file: fname, afp_id: result.id, app_number: result.app_number,
        certified_amount: result.certified_amount, matched: result.matched_count,
        lines: result.line_count, unmatched: result.unmatched_count,
      });
    } catch (e) {
      failed.push({ file: fname, error: e instanceof Error ? e.message : String(e) });
    }
  }

  await sendCertificateReply(env, senderRaw, subject, { project, applied, noTarget, failed });
}

/**
 * labourcerts@ flow — apply a subcontractor labour certificate to the newest
 * submitted incoming-labour application for the project. The QS certifies how
 * much of the subbie's claim PowerGrid agrees to pay, so (like clientcerts@)
 * it must be forwarded by PowerGrid staff. We detect which subcontractor it's
 * for from the forwarded body when possible, then lock in the certified figures
 * (submitted → certified). The certified labour can then be pushed to Xero.
 */
async function handleLabourCertificate(
  env: Env,
  args: {
    senderRaw: string;
    senderDomain: string;
    subject: string;
    attachments: Array<{ filename?: string | null; mimeType?: string | null; content: unknown }>;
    isPgStaff: boolean;
    body: { text: string | null; html: string | null };
  },
): Promise<void> {
  const { senderRaw, senderDomain, subject, attachments, isPgStaff, body } = args;

  if (!isPgStaff) {
    console.warn("labourcerts email rejected: sender not PG staff", { from: senderRaw, subject });
    await sendErrorReply(env, senderRaw, subject,
      `Labour payment certificates can only be forwarded by PowerGrid staff — the QS certifies the subcontractor's ` +
      `labour. Your address (${senderRaw}) isn't a registered PowerGrid user — ask an admin to add your account. ` +
      `(Subcontractors email their application to labourapps@, not labourcerts@.)`);
    return;
  }

  if (attachments.length === 0) {
    await sendErrorReply(env, senderRaw, subject,
      `We received your email but no PDF, Word (.docx) or XLSX certificate was attached. Please attach the certified labour breakdown and resend.`);
    return;
  }

  const projectResult = await resolveProject(env, {
    primary: [subject, ...attachments.map((a) => a.filename ?? "")].join("  "),
    body: `${body.text ?? ""}\n${body.html ?? ""}`,
  });
  if (projectResult === "none" || projectResult === "ambiguous") {
    await sendErrorReply(env, senderRaw, subject,
      projectResult === "ambiguous"
        ? `We found more than one project code in your email, so we couldn't tell which labour application this certifies. ` +
          `Please forward again with a single project code in the subject (e.g. "26001").`
        : `We couldn't find a project code in your email, so we couldn't match this certificate to a labour application. ` +
          `Please forward again with the project code in the subject (e.g. "26001").`);
    return;
  }
  const project = projectResult;

  // Which subcontractor? Detect from the forwarded body (the subbie's quoted
  // message). If we can't tell, we still certify the newest submitted labour
  // application for the project.
  const pgDomains = new Set<string>([senderDomain].filter(Boolean));
  const supplier = await detectForwardedSupplier(env, `${body.text ?? ""}\n${body.html ?? ""}`, subject, pgDomains);

  const applied: Array<{ file: string; afp_id: number; app_number: number; certified_amount: number; matched: number; lines: number; unmatched: number }> = [];
  const noTarget: string[] = [];
  const failed: Array<{ file: string; error: string }> = [];

  for (const att of attachments) {
    const fname = att.filename ?? "certificate.xlsx";
    try {
      const raw = att.content as ArrayBuffer | Uint8Array;
      const buf = raw instanceof ArrayBuffer ? raw : new Uint8Array(raw).buffer;
      const extracted = await extractCertificateLines(env, { buffer: buf, name: fname, type: att.mimeType ?? "" });
      const result = await applyClientCertificate(env, {
        projectId: project.id,
        extracted,
        actor: `email:${senderRaw}`,
        direction: "incoming_labour",
        counterpartySupplierId: supplier?.id ?? null,
      });
      if (!result) { noTarget.push(fname); continue; }
      await setAfpCertFile(env, result.id, { buffer: buf, name: fname, type: att.mimeType ?? "" }).catch(() => {});
      applied.push({
        file: fname, afp_id: result.id, app_number: result.app_number,
        certified_amount: result.certified_amount, matched: result.matched_count,
        lines: result.line_count, unmatched: result.unmatched_count,
      });
    } catch (e) {
      failed.push({ file: fname, error: e instanceof Error ? e.message : String(e) });
    }
  }

  await sendCertificateReply(env, senderRaw, subject, { project, applied, noTarget, failed, kind: "labour" });
}

// ── Resend-based outbound reply helpers ────────────────────────────────────

// Sending identity. Override with the RESEND_FROM secret if your verified
// Resend domain differs from the default below.
const DEFAULT_FROM = "PowerGrid Apps <apps@notifications.powergridprojects.co.uk>";

/**
 * Send one email via Resend and — crucially — surface HTTP-level failures.
 * A plain `fetch(...).catch()` only catches network errors; a 403/422 from
 * Resend (unverified domain, bad key, etc.) resolves normally, so we must
 * check res.ok and log the body or the failure is invisible.
 */
async function sendViaResend(env: Env, msg: { to: string; subject: string; html: string }): Promise<void> {
  if (!env.RESEND_API_KEY) {
    console.warn("RESEND_API_KEY not set — would have emailed", msg.to, "·", msg.subject);
    return;
  }
  const from = env.RESEND_FROM || DEFAULT_FROM;
  let res: Response | null = null;
  try {
    res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.RESEND_API_KEY}` },
      body: JSON.stringify({ from, to: [msg.to], subject: msg.subject, html: msg.html }),
    });
  } catch (err) {
    console.error("Resend network error", err);
    return;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`Resend send FAILED ${res.status} from="${from}" to="${msg.to}" — ${body}`);
  } else {
    console.log(`Resend send ok → ${msg.to} ("${msg.subject}")`);
  }
}

async function sendErrorReply(env: Env, to: string, originalSubject: string, body: string): Promise<void> {
  const html = `
    <p>We couldn't process the application you emailed in.</p>
    <p><b>Reason:</b> ${escapeHtml(body)}</p>
    <p style="color:#666;font-size:12px">Original subject: ${escapeHtml(originalSubject) || "(none)"}</p>`;
  await sendViaResend(env, {
    to,
    subject: `Re: ${originalSubject || "Application"} — couldn't process`,
    html,
  });
}

async function sendOutcomeReply(env: Env, to: string, originalSubject: string, args: {
  direction: "outgoing" | "incoming_labour";
  project: { id: string; code: string; name: string } | null;
  supplier: LabourSupplier | null;
  created: Array<{ file: string; afp_id: number; app_number: number; extracted: number; matched: number; unmatched: number }>;
  parked: Array<{ file: string; lines: number }>;
  failed: Array<{ file: string; error: string }>;
  duplicates?: Array<{ file: string; afp_id: number | null; app_number: number | null; status: string; project_code: string | null }>;
  supplierUnresolved: boolean;
}): Promise<void> {
  if (!env.RESEND_API_KEY) {
    console.warn("RESEND_API_KEY not set — would have replied with outcome", { to, args });
    return;
  }
  const isOutgoing = args.direction === "outgoing";
  const kind = isOutgoing ? "client application" : "labour application";
  const baseUrl = env.APP_BASE_URL ?? "";
  const okRows = args.created.map((c) => `
    <tr>
      <td>${escapeHtml(c.file)}</td>
      <td>#${c.app_number}</td>
      <td>${c.matched} / ${c.extracted} lines matched</td>
      <td>${c.unmatched > 0 ? `${c.unmatched} need review` : "—"}</td>
      <td><a href="${baseUrl}/applications/${c.afp_id}">Open draft →</a></td>
    </tr>`).join("");
  const failRows = args.failed.map((f) => `
    <tr style="color:#b91c1c">
      <td>${escapeHtml(f.file)}</td>
      <td colspan="4">Failed: ${escapeHtml(f.error)}</td>
    </tr>`).join("");

  const dupes = args.duplicates ?? [];
  const dupeList = dupes.map((d) => `<li>${escapeHtml(d.file)} — already in the system as ${
    d.afp_id != null
      ? `application #${d.app_number}${d.project_code ? ` on ${escapeHtml(d.project_code)}` : ""} (${escapeHtml(d.status)}) — <a href="${baseUrl}/applications/${d.afp_id}">open it →</a>`
      : "a document awaiting project assignment in the inbound tray"
  }</li>`).join("");
  const dupeSection = dupeList
    ? `<p><b>Already received — nothing new created:</b></p><ul>${dupeList}</ul>
       <p style="color:#666;font-size:12px">These attachments are byte-identical to documents we already hold, so no duplicate drafts were made.</p>`
    : "";

  // Everything in the email was a document we already hold → say just that.
  if (dupes.length && !args.created.length && !args.parked.length && !args.failed.length) {
    await sendViaResend(env, {
      to,
      subject: `Re: ${originalSubject || kind} — already received`,
      html: `<p>Thanks — we already have ${dupes.length === 1 ? "this document" : "these documents"}, so nothing new was created.</p>${dupeSection}`,
    });
    return;
  }

  // Project couldn't be resolved → everything was parked in the inbound tray.
  if (!args.project) {
    const parkedList = args.parked.map((p) => `<li>${escapeHtml(p.file)} — ${p.lines} lines extracted</li>`).join("");
    const pickWhat = isOutgoing ? "the project" : "the project (and subcontractor)";
    const html = `
      <p>Thanks — we received your ${kind}, but <b>couldn't tell which project it's for</b>
         (no project code in the subject, filename, or body).</p>
      <p>We've parked it in the <b>Applications → Needs assignment</b> tray. A PowerGrid PM just needs to
         pick ${pickWhat} and the draft will be created automatically.</p>
      ${parkedList ? `<ul>${parkedList}</ul>` : ""}
      ${dupeSection}
      <p><a href="${baseUrl}/applications">Open the Applications workspace →</a></p>
      <p style="color:#666;font-size:12px">Tip: next time, put the project code (e.g. "26001") in the subject and we'll route it straight to a draft.</p>`;
    await sendViaResend(env, { to, subject: `Re: ${originalSubject || kind} — received, needs a project`, html });
    return;
  }

  // Outgoing apps go to the project's client (implicit) — no subbie line.
  const counterpartyLine = isOutgoing
    ? `<b>To:</b> client (per project)`
    : args.supplier
      ? `<b>Subcontractor:</b> ${escapeHtml(args.supplier.name)}`
      : `<b>Subcontractor:</b> <span style="color:#b45309">not auto-detected — please open each draft and pick the subbie before submitting</span>`;
  const html = `
    <p>Thanks — we received your ${kind}.</p>
    <p>
      <b>Project:</b> ${escapeHtml(args.project.code)} — ${escapeHtml(args.project.name)}<br>
      ${counterpartyLine}
    </p>${(!isOutgoing && args.supplierUnresolved) ? `
    <p style="background:#fef3c7;border-left:4px solid #f59e0b;padding:8px 12px;font-size:13px">
      We couldn't tell which subcontractor this came from (forwarded by a PowerGrid address).
      The draft is created but you'll need to assign the subbie on the AfP page.
    </p>` : ""}
    <table style="border-collapse:collapse;font-size:14px">
      <thead style="background:#f1f5f9">
        <tr>
          <th align="left">File</th>
          <th align="left">Draft AfP</th>
          <th align="left">Lines</th>
          <th align="left">Review needed</th>
          <th align="left"></th>
        </tr>
      </thead>
      <tbody>${okRows}${failRows}</tbody>
    </table>
    ${dupeSection}
    <p style="color:#666;font-size:12px;margin-top:16px">
      The drafts are in PowerGrid's system at "draft" status. The PM will review and submit.
      If something looks wrong, reply to this email and we'll sort it.
    </p>`;

  await sendViaResend(env, {
    to,
    subject: `Re: ${originalSubject || kind} — received (${args.created.length} draft${args.created.length === 1 ? "" : "s"} created)`,
    html,
  });
}

/** Reply to the PM who forwarded a client payment certificate. */
async function sendCertificateReply(env: Env, to: string, originalSubject: string, args: {
  project: { id: string; code: string; name: string };
  applied: Array<{ file: string; afp_id: number; app_number: number; certified_amount: number; matched: number; lines: number; unmatched: number }>;
  noTarget: string[];
  failed: Array<{ file: string; error: string }>;
  kind?: "client" | "labour";
}): Promise<void> {
  const kind = args.kind ?? "client";
  const who = kind === "labour" ? "subcontractor's" : "client's";
  const baseUrl = env.APP_BASE_URL ?? "";
  const money = (n: number) =>
    "£" + n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const okRows = args.applied.map((a) => `
    <tr>
      <td>${escapeHtml(a.file)}</td>
      <td>#${a.app_number}</td>
      <td>${money(a.certified_amount)}</td>
      <td>${a.matched} / ${a.lines} lines</td>
      <td><a href="${baseUrl}/applications/${a.afp_id}">Open certificate →</a></td>
    </tr>`).join("");
  const noTargetRows = args.noTarget.map((f) => `
    <tr style="color:#b45309">
      <td>${escapeHtml(f)}</td>
      <td colspan="4">No application awaiting certification for this project — nothing to match against.</td>
    </tr>`).join("");
  const failRows = args.failed.map((f) => `
    <tr style="color:#b91c1c">
      <td>${escapeHtml(f.file)}</td>
      <td colspan="4">Failed: ${escapeHtml(f.error)}</td>
    </tr>`).join("");

  const certifiedAny = args.applied.length > 0;
  const intro = certifiedAny
    ? `Thanks — we've matched the ${who} certificate to the application and recorded the certified figures.`
    : `Thanks — we received the ${who} certificate, but couldn't apply it (see below).`;

  const html = `
    <p>${intro}</p>
    <p><b>Project:</b> ${escapeHtml(args.project.code)} — ${escapeHtml(args.project.name)}</p>
    <table style="border-collapse:collapse;font-size:14px">
      <thead style="background:#f1f5f9">
        <tr>
          <th align="left">File</th>
          <th align="left">Application</th>
          <th align="left">Certified</th>
          <th align="left">Lines matched</th>
          <th align="left"></th>
        </tr>
      </thead>
      <tbody>${okRows}${noTargetRows}${failRows}</tbody>
    </table>
    ${certifiedAny ? `
    <p style="color:#666;font-size:12px;margin-top:16px">
      The certified figures are locked and can't be edited. Open the certificate to create the
      sales invoice and push it to Xero.
    </p>` : `
    <p style="color:#666;font-size:12px;margin-top:16px">
      Tip: make sure the application has been <b>submitted</b> to the client before forwarding their
      certificate, and include the project code (e.g. "26001") in the subject.
    </p>`}`;

  await sendViaResend(env, {
    to,
    subject: `Re: ${originalSubject || "Payment certificate"} — ${certifiedAny ? `certified (${money(args.applied.reduce((s, a) => s + a.certified_amount, 0))})` : "couldn't apply"}`,
    html,
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c] as string));
}
