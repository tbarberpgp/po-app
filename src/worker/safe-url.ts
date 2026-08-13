// Shared SSRF guard. Remote media URLs arrive from untrusted sources (the
// WhatsApp ingest webhook body, inbound email) and are later fetched
// server-side by the Worker, so a bare fetch() would let them target internal /
// link-local hosts. Only allow https to a public host.
export function isSafeMediaUrl(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal")) return false;
  if (h.includes(":") || h === "[::1]") return false; // IPv6 literal — reject (can't cheaply range-check)
  // Reject IP-literal hosts in private / loopback / link-local / CGNAT ranges.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    const p = h.split(".").map(Number);
    if (p.some((n) => n > 255)) return false;
    if (p[0] === 10 || p[0] === 127 || p[0] === 0 ||
        (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
        (p[0] === 192 && p[1] === 168) ||
        (p[0] === 169 && p[1] === 254) ||
        (p[0] === 100 && p[1] >= 64 && p[1] <= 127)) return false;
  }
  return true;
}
