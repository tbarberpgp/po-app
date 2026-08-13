// Client wrappers around the shared H&S pack builder (src/shared/hs-pack-pdf):
// fetch the logo, build the bytes, trigger a download. The worker uses the
// same builder for the scheduled email release.

import { buildHsPack } from "../../shared/hs-pack-pdf";
import type { HsPackAck, HsPackBriefing, HsPackQual, HsPackSignin, HsPackTalk } from "../../shared/hs-pack-pdf";

export type AttendancePdfSignin = HsPackSignin;
export type AttendancePdfAck = HsPackAck;
export type AttendancePdfBriefing = HsPackBriefing;

async function fetchLogo(): Promise<Uint8Array | null> {
  try {
    const res = await fetch("/logo.png");
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch { return null; }
}

function download(bytes: Uint8Array, filename: string) {
  const blob = new Blob([bytes as unknown as BlobPart], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/** Attendance & briefing acceptance PDF (register + briefing texts + acks). */
export async function generateAttendancePdf(
  projectCode: string,
  projectName: string,
  from: string,
  to: string,
  signins: HsPackSignin[],
  acks: HsPackAck[],
  briefings: HsPackBriefing[],
) {
  const bytes = await buildHsPack({
    projectCode, projectName, from, to, signins, acks, briefings,
    logoPng: await fetchLogo(),
  });
  download(bytes, `${projectCode || "site"}-attendance-${from}_to_${to}.pdf`);
}

/** Full H&S pack: register + briefings + toolbox-talk copies + qualifications. */
export async function generateHsPackPdf(
  projectCode: string,
  projectName: string,
  from: string,
  to: string,
  signins: HsPackSignin[],
  acks: HsPackAck[],
  briefings: HsPackBriefing[],
  talks: HsPackTalk[],
  quals: HsPackQual[],
) {
  const bytes = await buildHsPack({
    projectCode, projectName, from, to, signins, acks, briefings, talks, quals,
    logoPng: await fetchLogo(),
    today: new Date().toISOString().slice(0, 10),
  });
  download(bytes, `${projectCode || "site"}-hs-pack-${from}_to_${to}.pdf`);
}
