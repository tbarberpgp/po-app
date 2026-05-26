import { useEffect, useState } from "react";
import { api, fmtDate } from "../lib/api";
import { Topbar } from "./Shell";
import { can } from "../../shared/permissions";
import type { CurrentUser } from "../../shared/types";

type Row = Awaited<ReturnType<typeof api.listDeletedProjects>>[number];

export function DeletedProjects({ me }: { me: CurrentUser | null }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [restoredInfo, setRestoredInfo] = useState<string | null>(null);

  const canRestore = can(me?.role, "projects.delete");

  function refresh() {
    api.listDeletedProjects().then(setRows).catch((e) => setErr(e.message));
  }
  useEffect(refresh, []);

  async function restore(id: string, originalCode: string) {
    if (!confirm(`Restore project "${originalCode}"? Its purchase orders, materials and approvers will reappear.`)) return;
    setBusyId(id); setErr(null); setRestoredInfo(null);
    try {
      const res = await api.restoreProject(id);
      if (res.code !== originalCode) {
        setRestoredInfo(`Restored as "${res.code}" — the original code "${originalCode}" was already in use by a live project.`);
      } else {
        setRestoredInfo(`Restored "${res.code}".`);
      }
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "restore failed");
    } finally {
      setBusyId(null);
    }
  }

  // Display the original code (strip the #deleted-<ts> suffix).
  const display = (code: string) => code.split("#deleted-")[0];

  return (
    <>
      <Topbar crumbs="Master data" title="Deleted projects" />
      <main>
        {err && <div className="flash error">{err}</div>}
        {restoredInfo && <div className="flash success">{restoredInfo}</div>}

        <div className="card">
          <div className="card-hd">
            <h2 style={{ flex: 1 }}>Soft-deleted projects</h2>
            <span className="pill">{rows.length}</span>
          </div>
          {rows.length === 0 ? (
            <div style={{ padding: 32 }}>
              <div className="empty">No deleted projects. Anything a Superadmin deletes lands here.</div>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Original code</th>
                  <th>Name</th>
                  <th>Client</th>
                  <th className="num">POs hidden</th>
                  <th>Deleted</th>
                  <th>By</th>
                  <th>Reason</th>
                  <th style={{ width: 110 }}></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const code = display(r.code);
                  return (
                    <tr key={r.id}>
                      <td><span className="pill deleted">{code}</span></td>
                      <td>{r.name}</td>
                      <td className="muted">{r.client ?? ""}</td>
                      <td className="num">{r.po_count}</td>
                      <td className="muted">{fmtDate(r.deleted_at)}</td>
                      <td className="muted">{r.deleted_by}</td>
                      <td className="muted" style={{ maxWidth: 280, whiteSpace: "normal" }}>
                        {r.deletion_reason ?? <span className="muted">—</span>}
                      </td>
                      <td>
                        {canRestore && (
                          <button
                            className="ghost tiny"
                            disabled={busyId === r.id}
                            onClick={() => restore(r.id, code)}
                          >
                            {busyId === r.id ? "Restoring…" : "Restore"}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </main>
    </>
  );
}
