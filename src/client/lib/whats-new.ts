// Changelog shown on the "What's new" page. Newest entry first; its `id` is
// what the sidebar compares against `localStorage["whatsnew.seen"]` to decide
// whether to show the little red "unseen" dot. Bump the top entry's id when
// you ship something worth flagging.

export type ChangelogEntry = { id: string; date: string; title: string; points: string[] };

export const CHANGELOG: ChangelogEntry[] = [
  {
    id: "2026-06-12",
    date: "12 June 2026",
    title: "Guide, new roles & a refreshed sidebar",
    points: [
      "New Guide & help page — role-aware instructions for every workspace.",
      "Sidebar reorganised with icons and collapsible sections.",
      "New roles — Commercial, Project Manager and Site — each with the right access.",
      "Site supervisors can sign in with a one-time PIN, no company email needed.",
      "Mobile delivery check-in tidied up: aligned quantity steppers and a clearer confirm button.",
    ],
  },
  {
    id: "2026-05",
    date: "May 2026",
    title: "Programme & stock",
    points: [
      "Import a project programme from Excel and see it as a Gantt chart.",
      "Programme activities link to bill items and drive a stock-demand list you can raise POs from.",
      "RAMS version automatically — a re-upload supersedes the old copy and resets who's read it.",
    ],
  },
  {
    id: "2026-04",
    date: "April 2026",
    title: "Plant & the reporting dashboard",
    points: [
      "Owned-plant register with transfers between sites and test-date reminders.",
      "Hiring plant raises the hire PO and tracks the off-hire date for you.",
      "Admin dashboard: portfolio KPIs, cash position and cash-flow charts.",
    ],
  },
  {
    id: "2026-03",
    date: "March 2026",
    title: "Operations on site",
    points: [
      "Delivery check-in by photographing the ticket — matched against the PO.",
      "QR site sign-in, daily briefings, toolbox talks and progress photos.",
      "Operative profiles with inductions, qualifications and RAMS reading.",
    ],
  },
];

export const WHATS_NEW_LATEST_ID = CHANGELOG[0]?.id ?? "";
