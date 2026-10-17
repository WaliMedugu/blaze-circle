import { certBody, packVoucher, unpackVoucher, voucherBody } from "./encoding";
import { importRawPublic, sign, verify } from "./keys";
import { canPayOffline, CERT_TTL_S, CLAIM_WINDOW_S, MAX_PENDING, MAX_POCKET, REQUEST_WINDOW_S } from "./rules";
import type { ChargeRequest, PocketCert, PocketState, Result, Voucher } from "./types";

/** Server: bank signs a pocket cert after placing the lien. */
export async function issueCert(
  bankPrivate: CryptoKey,
  fields: Omit<PocketCert, "v" | "iat" | "exp">,
  now: number,
): Promise<{ cert: PocketCert; bankSig: Uint8Array }> {
  if (fields.lim <= 0 || fields.lim > MAX_POCKET) throw new Error("pocket limit out of bounds");
  const cert: PocketCert = { v: 1, ...fields, iat: now, exp: now + CERT_TTL_S };
  return { cert, bankSig: await sign(bankPrivate, certBody(cert)) };
}

/** Payer phone: check rules, sign, advance local state. Returns the QR payload. */
export async function payOffline(
  state: PocketState,
  req: ChargeRequest,
  deviceKey: CryptoKey,
  now: number,
): Promise<Result<{ qr: string; voucher: Voucher; next: PocketState }>> {
  const gate = canPayOffline(state, req.amt, now);
  if (!gate.ok) return gate;
  const voucher: Voucher = {
    cid: state.cert.cid,
    ctr: state.ctr + 1,
    amt: req.amt,
    mid: req.mid,
    rn: req.rn,
    spentAfter: state.spent + req.amt,
  };
  const sig = await sign(deviceKey, voucherBody(voucher));
  return {
    ok: true,
    voucher,
    qr: packVoucher(state.cert, state.bankSig, voucher, sig),
    next: { ...state, ctr: voucher.ctr, spent: voucher.spentAfter },
  };
}

type Decoded = { cert: PocketCert; voucher: Voucher };

/** Signature + bounds checks shared by merchant and server. Signatures first: nothing else is trusted until they pass. */
async function verifyCore(qr: string, bankPublic: CryptoKey): Promise<Result<Decoded & { sig: Uint8Array }>> {
  let d: ReturnType<typeof unpackVoucher>;
  try {
    d = unpackVoucher(qr);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const { cert, bankSig, voucher, sig } = d;
  if (!(await verify(bankPublic, bankSig, certBody(cert)))) return { ok: false, reason: "bad_cert_sig" };
  let devicePublic: CryptoKey;
  try {
    devicePublic = await importRawPublic(cert.pk);
  } catch {
    return { ok: false, reason: "bad_cert_sig" };
  }
  if (!(await verify(devicePublic, sig, voucherBody(voucher)))) return { ok: false, reason: "bad_sig" };
  if (voucher.cid !== cert.cid || voucher.amt <= 0) return { ok: false, reason: "malformed" };
  if (voucher.ctr < 1 || voucher.ctr > MAX_PENDING) return { ok: false, reason: "counter_exceeded" };
  if (voucher.spentAfter > cert.lim || cert.lim > MAX_POCKET) return { ok: false, reason: "over_limit" };
  return { ok: true, cert, voucher, sig };
}

export interface MerchantContext {
  bankPublic: CryptoKey;
  merchantId: string;
  open: ChargeRequest; // the request this merchant is currently showing
  now: number; // merchant clock
  seen: Set<string>; // `${cid}:${ctr}` already accepted on this device
}

/** Merchant phone, fully offline. On success the sale is "Guaranteed" — funds are liened at the bank. */
export async function acceptVoucher(qr: string, ctx: MerchantContext): Promise<Result<Decoded>> {
  const r = await verifyCore(qr, ctx.bankPublic);
  if (!r.ok) return r;
  const { cert, voucher } = r;
  if (ctx.now > cert.exp) return { ok: false, reason: "cert_expired" };
  if (voucher.mid !== ctx.merchantId) return { ok: false, reason: "wrong_merchant" };
  if (voucher.rn !== ctx.open.rn) return { ok: false, reason: "nonce_mismatch" };
  if (voucher.amt !== ctx.open.amt) return { ok: false, reason: "amount_mismatch" };
  if (ctx.now - ctx.open.t > REQUEST_WINDOW_S) return { ok: false, reason: "expired" };
  if (ctx.seen.has(`${voucher.cid}:${voucher.ctr}`)) return { ok: false, reason: "replay" };
  return { ok: true, cert, voucher };
}

/**
 * Server, on upload. It can't re-check the 90 s window (it wasn't there) — that was the merchant's job,
 * and the nonce binding means a replayed voucher can only ever land on the original sale.
 * Duplicate (cid, ctr) is caught by the DB unique index inside settle_voucher().
 */
export async function validateUpload(qr: string, bankPublic: CryptoKey, now: number): Promise<Result<Decoded>> {
  const r = await verifyCore(qr, bankPublic);
  if (!r.ok) return r;
  if (now > r.cert.exp + CLAIM_WINDOW_S) return { ok: false, reason: "expired" };
  return { ok: true, cert: r.cert, voucher: r.voucher };
}
