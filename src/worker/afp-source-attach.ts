/**
 * Attach a document the app already stores to an application that has none.
 *
 * Why this exists. Some applications were keyed in by hand while their
 * document arrived another way — Cladders #1 (Invoice 001) was certified and
 * later paid with no file on it, while the same PDF sat on #6, a duplicate
 * upload. With nothing to point at, "#1 is Invoice 001" rested on matching
 * figures rather than on the paper. This lets the stored document be pointed
 * at from the application it belongs to, through the app, with an audit row —
 * so the duplicate can then be deleted without losing the evidence.
 *
 * It never uploads or copies anything: both rows reference the same stored
 * object, and deleting an application leaves its stored object in place.
 *
 * Planning is pure and refuses rather than guesses: the target must have no
 * document already (nothing is overwritten), and the source must be the same
 * subcontractor's — and, for an application, the same project's.
 */

export type AttachTarget = {
  id: number;
  project_id: string;
  counterparty_supplier_id: number | null;
  source_file_key: string | null;
};

export type AttachSource =
  | {
      kind: "afp";
      id: number;
      project_id: string;
      counterparty_supplier_id: number | null;
      source_file_key: string | null;
      source_file_name: string | null;
      source_file_type: string | null;
      source_file_hash: string | null;
    }
  | {
      kind: "inbound";
      id: number;
      counterparty_supplier_id: number | null;
      source_file_key: string | null;
      source_file_name: string | null;
      source_file_type: string | null;
      source_file_hash: string | null;
    };

export type AttachPlan =
  | {
      ok: true;
      file: { key: string; name: string | null; type: string | null; hash: string | null };
      audit: { from: string; key: string; name: string | null };
    }
  | { ok: false; error: string };

export function planAttachSource(target: AttachTarget, source: AttachSource, name?: string | null): AttachPlan {
  const from = `${source.kind === "afp" ? "application" : "inbound item"} id ${source.id}`;
  if (source.kind === "afp" && source.id === target.id) {
    return { ok: false, error: "an application can't take its own document" };
  }
  if (target.source_file_key) {
    return { ok: false, error: "this application already has a document — nothing is overwritten" };
  }
  if (!source.source_file_key) {
    return { ok: false, error: `${from} has no stored document` };
  }
  if (target.counterparty_supplier_id == null || source.counterparty_supplier_id !== target.counterparty_supplier_id) {
    return { ok: false, error: `${from} belongs to a different subcontractor` };
  }
  if (source.kind === "afp" && source.project_id !== target.project_id) {
    return { ok: false, error: `${from} is on a different project` };
  }
  const label = String(name ?? "").trim() || source.source_file_name;
  return {
    ok: true,
    file: { key: source.source_file_key, name: label, type: source.source_file_type, hash: source.source_file_hash },
    audit: { from, key: source.source_file_key, name: label },
  };
}
