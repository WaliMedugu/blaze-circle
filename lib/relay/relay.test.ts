import { describe, expect, it, beforeAll } from "vitest";
import { base45Decode, base45Encode, certBody, packVoucher, randomHex, unpackVoucher } from "./encoding";
import { exportRawPublic, generateBankKey, generateDeviceKey } from "./keys";
import { acceptVoucher, issueCert, payOffline, validateUpload } from "./protocol";
import { canPayOffline, CERT_TTL_S } from "./rules";
import type { ChargeRequest, PocketState } from "./types";

const NOW = 1_760_000_000;
let bank: CryptoKeyPair, device: CryptoKeyPair, state: PocketState;

const request = (amt: number, t = NOW): ChargeRequest => ({ mid: "m_mama_tee", mname: "Mama Tee", amt, rn: randomHex(), t });
const ctx = (open: ChargeRequest, now = NOW + 5, seen = new Set<string>()) => ({
  bankPublic: bank.publicKey, merchantId: "m_mama_tee", open, now, seen,
});

beforeAll(async () => {
  bank = await generateBankKey();
  device = await generateDeviceKey();
  const { cert, bankSig } = await issueCert(
    bank.privateKey,
    { cid: "c1", uid: "u1", tag: "$wali", did: "d1", pk: await exportRawPublic(device.publicKey), lim: 5000 },
    NOW,
  );
  state = { cert, bankSig, ctr: 0, spent: 0 };
});

async function pay(s: PocketState, req: ChargeRequest) {
  const r = await payOffline(s, req, device.privateKey, NOW);
  if (!r.ok) throw new Error(r.reason);
  return r;
}

describe("encoding", () => {
  it("base45 round-trips (RFC 9285 vector)", () => {
    expect(base45Encode(new TextEncoder().encode("AB"))).toBe("BB8");
    const b = crypto.getRandomValues(new Uint8Array(101));
    expect(base45Decode(base45Encode(b))).toEqual(b);
  });
  it("encodes byte fields untagged, so Node and browsers sign identical bytes", () => {
    const body = certBody(state.cert);
    const hex = Array.from(body, (b) => b.toString(16).padStart(2, "0")).join("");
    expect(hex).toContain("5841"); // CBOR byte string, length 65 (the device key)
    expect(hex).not.toContain("d840"); // tag 64 = typed-array tag that browsers don't emit
  });
  it("voucher QR stays small enough for a phone-screen QR", async () => {
    const { qr } = await pay(state, request(500));
    expect(qr.length).toBeLessThan(600);
  });
});

describe("happy path", () => {
  it("merchant accepts a valid offline voucher, server validates it", async () => {
    const req = request(3500);
    const { qr } = await pay(state, req);
    expect((await acceptVoucher(qr, ctx(req))).ok).toBe(true);
    expect((await validateUpload(qr, bank.publicKey, NOW + 3600)).ok).toBe(true);
  });
});

describe("attacks the Risk Console demos", () => {
  it("replay of an already-accepted voucher", async () => {
    const req = request(500);
    const { qr, voucher } = await pay(state, req);
    const seen = new Set([`${voucher.cid}:${voucher.ctr}`]);
    expect(await acceptVoucher(qr, ctx(req, NOW + 5, seen))).toEqual({ ok: false, reason: "replay" });
  });
  it("voucher presented to a different sale (nonce) or merchant", async () => {
    const { qr } = await pay(state, request(500));
    expect(await acceptVoucher(qr, ctx(request(500)))).toEqual({ ok: false, reason: "nonce_mismatch" });
    const other = { ...ctx(request(500)), merchantId: "m_other" };
    expect(await acceptVoucher(qr, other)).toEqual({ ok: false, reason: "wrong_merchant" });
  });
  it("scanned after the 90 s window (merchant clock)", async () => {
    const req = request(500);
    const { qr } = await pay(state, req);
    expect(await acceptVoucher(qr, ctx(req, NOW + 91))).toEqual({ ok: false, reason: "expired" });
  });
  it("tampered amount breaks the device signature", async () => {
    const req = request(500);
    const { qr } = await pay(state, req);
    const d = unpackVoucher(qr);
    const forged = packVoucher(d.cert, d.bankSig, { ...d.voucher, amt: 50 }, d.sig);
    expect(await acceptVoucher(forged, ctx({ ...req, amt: 50 }))).toEqual({ ok: false, reason: "bad_sig" });
  });
  it("self-issued cert with a bigger limit fails the bank signature", async () => {
    const req = request(500);
    const { qr } = await pay(state, req);
    const d = unpackVoucher(qr);
    const forged = packVoucher({ ...d.cert, lim: 50_000 }, d.bankSig, d.voucher, d.sig);
    expect(await acceptVoucher(forged, ctx(req))).toEqual({ ok: false, reason: "bad_cert_sig" });
  });
  it("garbage QR", async () => {
    expect(await acceptVoucher("HELLO", ctx(request(1)))).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("canPayOffline (payer-side gate)", () => {
  it("allows a normal payment", () => {
    expect(canPayOffline(state, 1000, NOW)).toEqual({ ok: true });
  });
  it("blocks the 4th offline payment", () => {
    expect(canPayOffline({ ...state, ctr: 3, spent: 1500 }, 100, NOW)).toEqual({ ok: false, reason: "counter_exceeded" });
  });
  it("blocks spending past the pocket", () => {
    expect(canPayOffline({ ...state, ctr: 1, spent: 4000 }, 1500, NOW)).toEqual({ ok: false, reason: "over_limit" });
  });
  it("blocks an expired cert", () => {
    expect(canPayOffline(state, 100, NOW + CERT_TTL_S + 1)).toEqual({ ok: false, reason: "cert_expired" });
  });
  it("rejects nonsense amounts", () => {
    expect(canPayOffline(state, 0, NOW)).toEqual({ ok: false, reason: "malformed" });
    expect(canPayOffline(state, 12.5, NOW)).toEqual({ ok: false, reason: "malformed" });
  });
});
