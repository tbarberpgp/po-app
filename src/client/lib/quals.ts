// Standard competency / qualification card types. Shared by the operative
// self-upload page, the manager register upload, and the site training matrix
// so the pick-lists and matrix columns can never drift apart.
export const QUAL_TYPES = [
  "CSCS",
  "ECS",
  "IPAF",
  "PASMA",
  "First aid",
  "SSSTS / SMSTS",
  "Asbestos awareness",
  "Other",
] as const;

// Columns for a training matrix: every standard competency except the catch-all
// "Other" (extra/free-text types found in the data are appended by the caller).
export const MATRIX_QUAL_TYPES = QUAL_TYPES.filter((t) => t !== "Other");
