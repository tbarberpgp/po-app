// Client-side .xlsx export of the sign-in register with briefing acceptance —
// the H&S paper trail in the form an auditor or principal contractor expects.
// Sheet 1 merges the two: one row per sign-in, showing the daily briefing
// accepted at sign-in (acceptance is mandatory to sign in) plus any toolbox
// talks acknowledged in the same visit. Sheet 2 is the acknowledgement detail.

import * as XLSX from "xlsx";

export function generateAttendanceXlsx(
  projectCode: string,
  from: string,
  to: string,
  signins: Array<{ id: number; name: string; company: string | null; trade: string | null; phone: string | null; signed_in_at: string; signed_out_at: string | null; signed_out_auto?: number; briefing_tag?: string | null }>,
  acks: Array<{ signin_id: number | null; name: string; acked_at: string; notice_type: string; title: string; notice_date: string; company: string | null; trade: string | null }>,
  briefings: Array<{ tag: string; title: string; content: string | null; effective_from: string }>,
) {
  const wb = XLSX.utils.book_new();
  // Times in UK wall-clock (stored ISO timestamps are UTC).
  const d = (iso: string | null) => (iso
    ? new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso))
    : "");
  const t = (iso: string | null) => (iso
    ? new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso))
    : "");

  // Toolbox/notice acknowledgements recorded against each sign-in.
  const acksBySignin = new Map<number, string[]>();
  for (const a of acks) {
    if (a.signin_id == null) continue;
    const list = acksBySignin.get(a.signin_id) ?? [];
    list.push(`${a.notice_type === "toolbox" ? "Toolbox: " : ""}${a.title}`);
    acksBySignin.set(a.signin_id, list);
  }

  // Signing in requires accepting the standing daily briefing, so acceptance
  // is recorded per row with the sign-in time — tagged with WHICH version
  // (B1, B2, …) was in force at that instant; the Briefings sheet holds the texts.
  const signinRows = signins.map((s) => ({
    Date: d(s.signed_in_at),
    Name: s.name,
    Company: s.company ?? "",
    Trade: s.trade ?? "",
    "Signed in": t(s.signed_in_at),
    "Signed out": s.signed_out_at ? `${t(s.signed_out_at)}${s.signed_out_auto ? " (auto)" : ""}` : "",
    "Daily briefing": s.briefing_tag ? `Accepted ${t(s.signed_in_at)} (${s.briefing_tag})` : "No standing briefing set",
    "Talks acknowledged": (acksBySignin.get(s.id) ?? []).join("; "),
  }));
  const ws1 = XLSX.utils.json_to_sheet(signinRows.length ? signinRows : [{ Date: "", Name: "No sign-ins in this range" }]);
  ws1["!cols"] = [{ wch: 11 }, { wch: 24 }, { wch: 22 }, { wch: 16 }, { wch: 9 }, { wch: 10 }, { wch: 20 }, { wch: 40 }];
  XLSX.utils.book_append_sheet(wb, ws1, "Sign-in register");

  // The briefing versions the tags refer to — full text per version.
  if (briefings.length) {
    const briefRows = briefings.map((b) => ({
      Tag: b.tag,
      Title: b.title,
      "In force from": `${d(b.effective_from)} ${t(b.effective_from)}`,
      Content: b.content ?? "",
    }));
    const ws3 = XLSX.utils.json_to_sheet(briefRows);
    ws3["!cols"] = [{ wch: 5 }, { wch: 40 }, { wch: 17 }, { wch: 100 }];
    XLSX.utils.book_append_sheet(wb, ws3, "Briefings");
  }

  // Explicitly recorded briefing / toolbox-talk acknowledgements.
  const ackRows = acks.map((a) => ({
    Date: d(a.acked_at),
    Time: t(a.acked_at),
    Name: a.name,
    Company: a.company ?? "",
    Trade: a.trade ?? "",
    Type: a.notice_type === "toolbox" ? "Toolbox talk" : "Briefing",
    Title: a.title,
    "Applies to": a.notice_date,
  }));
  const ws2 = XLSX.utils.json_to_sheet(ackRows.length ? ackRows : [{ Date: "", Name: "No recorded acknowledgements in this range" }]);
  ws2["!cols"] = [{ wch: 11 }, { wch: 7 }, { wch: 24 }, { wch: 22 }, { wch: 16 }, { wch: 13 }, { wch: 34 }, { wch: 11 }];
  XLSX.utils.book_append_sheet(wb, ws2, "Acknowledgements");

  XLSX.writeFile(wb, `${projectCode || "site"}-attendance-${from}_to_${to}.xlsx`);
}
