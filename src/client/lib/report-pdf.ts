// Shape of a daily / weekly site report's `data_json` (the AI summary enriched
// with weather, labour, programme, attendance, deliveries and safety). Rendered
// on screen by SiteReportDoc, which is also what we print-to-PDF — so there is
// no separate PDF renderer to drift out of sync. The Worker keeps its own copy
// of this type in routes/site-reports.ts; keep the two in step.

export type ReportSections = {
  headline: string;
  labour_count?: string;
  weather?: string;
  progress: string[];
  deliveries: string[];
  labour: string[];
  hse: string[];
  blockers: string[];
  lookahead: string[];
  photos?: Array<{ url: string; caption: string }>;
  weather_days?: Array<{ date: string; code: number; min: number; max: number; precip: number }>;
  labour_days?: Array<{ date: string; count: number }>;
  plant?: string[];
  safety?: { incidents: number; near_misses: number; toolbox_talks: number; rams_outstanding?: number };
  // Live programme position (from the project's imported programme), as of the
  // report date: day X of Y, overall % complete, and on/behind-programme status.
  programme?: { day: number; total_days: number; pct_overall: number; status: string } | null;
  // Sign-in attendance for the period. `visitors` = signed-in people not on the
  // active operative register (client reps, surveyors, inspectors, etc.).
  attendance?: { on_site: number; companies: number; first_in: string | null; last_out: string | null; inductions?: number; visitors?: number } | null;
  // Labour by company (headcount + hours + trade mix) and deliveries logged in the period.
  labour_table?: Array<{ company: string; count: number; hours: number; trade: string }>;
  deliveries_detail?: Array<{ supplier: string; description: string; po_number: string | null; status: string }>;
  // Section keys hidden from the exported copy (set via "Edit for client"), and
  // free-form sections the editor added — both persisted so the on-screen doc,
  // the PDF and the emailed copy all stay in step.
  hidden_sections?: string[];
  custom_sections?: Array<{ title: string; items: string[] }>;
};
