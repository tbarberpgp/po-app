import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import qrcode from "qrcode-generator";
import { api } from "../lib/api";
import type { QitpCabinCard, QitpDashboard as Dash } from "../../shared/types";
import { QITP_LIFT, fmtLiftDate } from "../../shared/qitp-lift";

function qrSvg(value: string): string {
  const qr = qrcode(0, "M");
  qr.addData(value);
  qr.make();
  return qr.createSvgTag({ cellSize: 6, margin: 1, scalable: true });
}

/** One printable QR label per cabin per page: a floor-coloured band, a large QR,
 *  and the cabin number in big type — so a stack sorts by floor and fixes to the
 *  right cabin. Floor band uses print-color-adjust:exact so it survives printing. */
export function QitpPrint() {
  const { id = "" } = useParams<{ id: string }>();
  const [dash, setDash] = useState<Dash | null>(null);
  const [floor, setFloor] = useState("All");
  const origin = typeof window !== "undefined" ? window.location.origin : "";

  useEffect(() => { api.qitpDashboard(id).then(setDash).catch(() => {}); }, [id]);

  const cabins = useMemo(
    () => (dash?.cabins ?? []).filter((c) => floor === "All" || c.floor === floor),
    [dash, floor],
  );

  if (!dash) return <div className="empty" style={{ padding: 40 }}>Loading…</div>;

  return (
    <div className="qitp-print-wrap">
      <div className="qitp-print-bar">
        <Link to={`/projects/${id}/qitp`} className="muted">← Back to QITP</Link>
        <div className="qitp-print-controls">
          {["All", "Top", "Middle", "Ground"].map((f) => (
            <button key={f} className={`qitp-chip${floor === f ? " on" : ""}`} onClick={() => setFloor(f)}>{f}</button>
          ))}
          <span className="muted" style={{ fontSize: 12 }}>{cabins.length} labels</span>
          <button className="btn accent" onClick={() => window.print()}>🖨️ Print</button>
        </div>
      </div>
      <div className="qitp-labels">
        {cabins.map((c) => <Label key={c.id} c={c} origin={origin} code={dash.project.code} />)}
      </div>
    </div>
  );
}

function Label({ c, origin, code }: { c: QitpCabinCard; origin: string; code: string }) {
  const svg = useMemo(() => qrSvg(`${origin}/cabin/${c.token}`), [origin, c.token]);
  return (
    <div className={`qitp-label floor-${c.floor.toLowerCase()}`}>
      <div className="qitp-label-band">{c.floor.toUpperCase()} FLOOR</div>
      <div className="qitp-label-body">
        <div className="qitp-label-qr" dangerouslySetInnerHTML={{ __html: svg }} />
        <div className="qitp-label-num">{c.number}</div>
        <div className="qitp-label-dates">
          Dismantle lift: <b>{fmtLiftDate(QITP_LIFT.lift)}</b> · Install: <b>{fmtLiftDate(c.reinstall_date ?? QITP_LIFT.install)}</b>
        </div>
        <div className="qitp-label-foot">{code} · Scan to inspect &amp; sign</div>
      </div>
    </div>
  );
}
