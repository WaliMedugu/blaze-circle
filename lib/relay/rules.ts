import type { PocketState, RejectReason } from "./types";

// Hard bounds from the risk table (BLAZE_GRID_BUILD_PLAN.md §3.4).
export const MAX_POCKET = 5_000; // ₦, pre-funded + liened, never credit
export const MAX_PENDING = 3; // offline vouchers per cert before a sync is required
export const REQUEST_WINDOW_S = 90; // measured on the merchant's clock only
export const CERT_TTL_S = 72 * 3600;
export const CLAIM_WINDOW_S = 72 * 3600; // after cert expiry, unclaimed vouchers are released

/**
 * Payer-side gate, run on the student's phone before it signs an offline voucher.
 * The merchant and the server re-check everything, so this is about UX (fail early with a
 * clear message) — but it is also the first line that keeps a pocket from being overdrawn.
 */
export function canPayOffline(
  state: PocketState,
  amount: number,
  now: number,
): { ok: true } | { ok: false; reason: RejectReason } {
  // TODO(human): decide when the payer's phone must refuse to sign.
  // Return { ok: false, reason } using one of: "cert_expired", "counter_exceeded", "over_limit", "malformed".
  throw new Error("canPayOffline not implemented");
}
