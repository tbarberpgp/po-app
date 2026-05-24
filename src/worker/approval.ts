import type { ApprovalTier, Settings } from "../shared/types";

export async function loadSettings(db: D1Database): Promise<Settings> {
  const rows = await db
    .prepare("SELECT key, value FROM settings")
    .all<{ key: string; value: string }>();
  const map = new Map(rows.results.map((r) => [r.key, r.value]));
  const n = (k: string, d: number) => {
    const v = map.get(k);
    return v ? Number(v) : d;
  };
  return {
    tier_threshold_line_manager: n("tier_threshold_line_manager", 2000),
    tier_threshold_commercial_manager: n("tier_threshold_commercial_manager", 10000),
    tier_threshold_director: n("tier_threshold_director", 50000),
    currency: map.get("currency") ?? "GBP",
  };
}

/**
 * Tier the PO by total value when it needs approval.
 *  <= line_manager threshold        → line_manager
 *  <= commercial_manager threshold  → commercial_manager
 *  otherwise                        → director
 *
 * Any unpriced material escalates at least to commercial_manager.
 */
export function tierForApproval(
  totalValue: number,
  hasUnpriced: boolean,
  s: Settings,
): ApprovalTier {
  let tier: ApprovalTier;
  if (totalValue <= s.tier_threshold_line_manager) tier = "line_manager";
  else if (totalValue <= s.tier_threshold_commercial_manager) tier = "commercial_manager";
  else tier = "director";

  if (hasUnpriced && tier === "line_manager") tier = "commercial_manager";
  return tier;
}
