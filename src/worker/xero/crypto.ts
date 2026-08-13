// AES-256-GCM encryption for the Xero OAuth tokens held at rest in D1.
//
// Why: a D1 export/backup — or any read of the single xero_connection row —
// otherwise yields a long-lived refresh_token granting full accounting
// read/write to the connected org (offline_access scope). Encrypting at rest
// means the stored bytes are useless without the key, which lives only as a
// Worker secret (never in D1, never in the repo).
//
// Key: the XERO_TOKEN_KEY Worker secret (set with `wrangler secret put
// XERO_TOKEN_KEY`, value e.g. `openssl rand -base64 32`). Any high-entropy
// string works — we derive a stable 256-bit AES key from it with SHA-256, so
// there's no base64/padding format to get wrong. Rotating the secret makes
// existing ciphertext undecryptable, so a rotation requires a Xero reconnect.
//
// Stored format:  "v1:" + base64( iv[12] || ciphertext+GCM-tag )
// The "v1:" version prefix lets decryptToken() tell an encrypted value from a
// legacy plaintext one, so the pre-encryption row keeps working and is
// re-stored encrypted on its next token refresh (dual-read migration — no
// disconnect/reconnect needed).

import type { Env } from "../env";

const PREFIX = "v1:";
const IV_BYTES = 12; // 96-bit nonce, the standard size for AES-GCM

// Derived AES key, cached per isolate. Keyed on the secret value so a rotated
// secret is picked up rather than serving a stale key.
let cached: { secret: string; key: CryptoKey } | null = null;

async function getKey(env: Env): Promise<CryptoKey> {
  const secret = env.XERO_TOKEN_KEY;
  if (!secret) {
    throw new Error(
      "XERO_TOKEN_KEY is not set — Xero tokens can't be encrypted/decrypted. " +
        "Set it with `wrangler secret put XERO_TOKEN_KEY`.",
    );
  }
  if (cached?.secret === secret) return cached.key;
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
  cached = { secret, key };
  return key;
}

/** True if `v` is one of our encrypted values (vs a legacy plaintext token). */
export function isEncrypted(v: string | null | undefined): boolean {
  return typeof v === "string" && v.startsWith(PREFIX);
}

/** Encrypt a token for storage. Throws if XERO_TOKEN_KEY is unset — we never
 *  silently fall back to plaintext, so a misconfiguration fails loudly instead
 *  of quietly re-introducing the vulnerability. */
export async function encryptToken(env: Env, plaintext: string): Promise<string> {
  const key = await getKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(plaintext),
    ),
  );
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv, 0);
  packed.set(ct, iv.length);
  return PREFIX + toBase64(packed);
}

/** Decrypt a stored token. A legacy plaintext value (no "v1:" prefix) is
 *  returned unchanged so the existing connection keeps working until its next
 *  refresh re-stores it encrypted. Throws if an encrypted value can't be
 *  decrypted (missing/rotated key or tampering). */
export async function decryptToken(env: Env, stored: string): Promise<string> {
  if (!isEncrypted(stored)) return stored; // dual-read: pre-encryption plaintext
  const key = await getKey(env);
  const packed = fromBase64(stored.slice(PREFIX.length));
  // Fresh ArrayBuffer-backed copies — subarray() views are typed ArrayBufferLike,
  // which the WebCrypto BufferSource type won't accept.
  const iv = new Uint8Array(packed.subarray(0, IV_BYTES));
  const ct = new Uint8Array(packed.subarray(IV_BYTES));
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    return new TextDecoder().decode(pt);
  } catch {
    // Wrong key (secret rotated/lost) or corrupted ciphertext. Surface a clear,
    // value-free message — the fix is to reconnect Xero (Admin → Xero).
    throw new Error(
      "Failed to decrypt a stored Xero token — the XERO_TOKEN_KEY may have " +
        "changed. Reconnect Xero (Admin → Xero: Disconnect, then Connect).",
    );
  }
}

/* ── base64 <-> bytes (binary-safe; tokens are short so no chunking needed) ── */

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
