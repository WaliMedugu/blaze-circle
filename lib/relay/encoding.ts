import { Encoder } from "cbor-x";
import type { ChargeRequest, PocketCert, Voucher } from "./types";

// One encoder config for every platform. cbor-x's default tags Uint8Array (tag 64) in Node but
// not in browsers, so the same cert would encode to different bytes and fail its bank signature.
const cbor = new Encoder({ tagUint8Array: false, useRecords: false });
const encode = (v: unknown) => cbor.encode(v);
const decode = (b: Uint8Array) => cbor.decode(b);

// Signed bodies are CBOR arrays in a fixed field order, so the bytes that get signed
// are identical on every device — object key order can never break a signature.

export const certBody = (c: PocketCert) =>
  bytes(encode([c.v, c.cid, c.uid, c.tag, c.did, c.pk, c.lim, c.iat, c.exp]));

export const voucherBody = (v: Voucher) =>
  bytes(encode([v.cid, v.ctr, v.amt, v.mid, v.rn, v.spentAfter]));

export function certFromArray(a: unknown[]): PocketCert {
  const [v, cid, uid, tag, did, pk, lim, iat, exp] = a;
  return { v: v as 1, cid, uid, tag, did, pk: bytes(pk as Uint8Array), lim, iat, exp } as PocketCert;
}

export function voucherFromArray(a: unknown[]): Voucher {
  const [cid, ctr, amt, mid, rn, spentAfter] = a;
  return { cid, ctr, amt, mid, rn, spentAfter } as Voucher;
}

/** Voucher QR payload: base45(cbor([certArr, bankSig, voucherArr, deviceSig])). */
export function packVoucher(cert: PocketCert, bankSig: Uint8Array, v: Voucher, sig: Uint8Array) {
  const certArr = decode(certBody(cert));
  const vArr = decode(voucherBody(v));
  return base45Encode(bytes(encode([certArr, bankSig, vArr, sig])));
}

export function unpackVoucher(qr: string) {
  const [certArr, bankSig, vArr, sig] = decode(base45Decode(qr)) as [unknown[], Uint8Array, unknown[], Uint8Array];
  return { cert: certFromArray(certArr), bankSig: bytes(bankSig), voucher: voucherFromArray(vArr), sig: bytes(sig) };
}

/** Pocket cert as sent from server to phone: base45(cbor([certArr, bankSig])). */
export const packCert = (cert: PocketCert, bankSig: Uint8Array) =>
  base45Encode(bytes(encode([decode(certBody(cert)), bankSig])));

export function unpackCert(s: string) {
  const [certArr, bankSig] = decode(base45Decode(s)) as [unknown[], Uint8Array];
  return { cert: certFromArray(certArr), bankSig: bytes(bankSig) };
}

export const packRequest =(r: ChargeRequest) =>
  base45Encode(bytes(encode([r.mid, r.mname, r.amt, r.rn, r.t])));

export function unpackRequest(qr: string): ChargeRequest {
  const [mid, mname, amt, rn, t] = decode(base45Decode(qr));
  return { mid, mname, amt, rn, t };
}

/** cbor-x may hand back a Node Buffer; normalise to a plain Uint8Array. */
export function bytes(b: Uint8Array): Uint8Array {
  return new Uint8Array(b.buffer, b.byteOffset, b.byteLength).slice();
}

export function randomHex(n = 16) {
  return Array.from(crypto.getRandomValues(new Uint8Array(n)), (x) => x.toString(16).padStart(2, "0")).join("");
}

export const b64url = {
  encode: (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  decode: (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)),
};

// Base45 (RFC 9285): uses only QR alphanumeric-mode characters, so QR codes stay ~20% smaller than base64.
const B45 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";

export function base45Encode(buf: Uint8Array): string {
  let out = "";
  for (let i = 0; i < buf.length; i += 2) {
    if (i + 1 < buf.length) {
      const x = buf[i] * 256 + buf[i + 1];
      out += B45[x % 45] + B45[Math.floor(x / 45) % 45] + B45[Math.floor(x / 2025)];
    } else {
      const x = buf[i];
      out += B45[x % 45] + B45[Math.floor(x / 45)];
    }
  }
  return out;
}

export function base45Decode(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i += 3) {
    const c = s.slice(i, i + 3).split("").map((ch) => {
      const n = B45.indexOf(ch);
      if (n < 0) throw new Error("base45: bad char");
      return n;
    });
    if (c.length === 3) {
      const x = c[0] + c[1] * 45 + c[2] * 2025;
      if (x > 0xffff) throw new Error("base45: overflow");
      out.push(x >> 8, x & 0xff);
    } else if (c.length === 2) {
      const x = c[0] + c[1] * 45;
      if (x > 0xff) throw new Error("base45: overflow");
      out.push(x);
    } else throw new Error("base45: bad length");
  }
  return Uint8Array.from(out);
}
