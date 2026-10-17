// Wire objects for the Blaze Relay offline payment protocol.
// See BLAZE_GRID_BUILD_PLAN.md §3. All times are unix seconds, all amounts whole Naira.

/** Issued online by the bank; proves "this device may spend up to `lim` from a liened pocket". */
export interface PocketCert {
  v: 1;
  cid: string; // cert id (uuid)
  uid: string; // payer user id
  tag: string; // $BlazeTag, for display on the merchant screen
  did: string; // device id
  pk: Uint8Array; // device public key, raw uncompressed P-256 (65 bytes)
  lim: number; // pocket amount locked by the bank, ≤ MAX_POCKET
  iat: number;
  exp: number;
}

/** Shown by the merchant (QR or chirp). `rn` binds the voucher to this exact sale. */
export interface ChargeRequest {
  mid: string; // merchant id
  mname: string;
  amt: number;
  rn: string; // 32 hex chars, fresh per request
  t: number; // merchant clock, issue time
}

/** Signed by the payer device and shown back to the merchant. */
export interface Voucher {
  cid: string;
  ctr: number; // 1..MAX_PENDING, single use per cert
  amt: number;
  mid: string;
  rn: string;
  spentAfter: number; // cumulative pocket spend including this voucher
}

/** What the payer device keeps locally between syncs. */
export interface PocketState {
  cert: PocketCert;
  bankSig: Uint8Array;
  ctr: number; // vouchers signed so far against this cert
  spent: number; // Naira signed away so far
}

export type RejectReason =
  | "malformed"
  | "bad_cert_sig"
  | "cert_expired"
  | "bad_sig"
  | "wrong_merchant"
  | "nonce_mismatch"
  | "amount_mismatch"
  | "expired"
  | "replay"
  | "over_limit"
  | "counter_exceeded";

export type Result<T> = ({ ok: true } & T) | { ok: false; reason: RejectReason };
