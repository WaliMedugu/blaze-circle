import { getBank } from "@/lib/bank";
import { validateUpload } from "@/lib/relay/protocol";
import { bankKeys, fail, nowS } from "@/lib/server/bank-key";

/** Upload of an offline voucher by the merchant (settles) or the payer (early report). */
export async function POST(req: Request) {
  const { qr, submittedBy } = await req.json();
  if (typeof qr !== "string" || (submittedBy !== "merchant" && submittedBy !== "payer")) return fail("bad_request");

  const bank = getBank();
  const r = await validateUpload(qr, (await bankKeys()).pub, nowS());
  if (!r.ok) {
    await bank.log(r.reason, undefined, `upload by ${submittedBy}`);
    return Response.json({ state: "REJECTED", reason: r.reason });
  }
  const pocket = await bank.getPocket(r.cert.cid);
  if (pocket && pocket.userId !== r.cert.uid) return Response.json({ state: "REJECTED", reason: "bad_cert_sig" });

  const state = await bank.settleVoucher({
    certId: r.cert.cid,
    ctr: r.voucher.ctr,
    merchantId: r.voucher.mid,
    amount: r.voucher.amt,
    nonce: r.voucher.rn,
    payload: qr,
    submittedBy,
  });
  return Response.json({ state, reason: state === "REJECTED" ? "unknown_cert" : undefined });
}
