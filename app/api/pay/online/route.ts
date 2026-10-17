import { mockBank } from "@/lib/bank/mock";
import { b64url, base45Decode, unpackRequest } from "@/lib/relay/encoding";
import { importRawPublic, verify } from "@/lib/relay/keys";
import { fail } from "@/lib/server/bank-key";

/** Online path: the device signs the merchant's request bytes; the bank debits the main balance. */
export async function POST(req: Request) {
  const { deviceId, request, sig } = await req.json();
  const device = mockBank.devices.get(deviceId);
  if (!device || device.revoked) return fail("unknown_device");

  let signed: Uint8Array;
  try {
    signed = base45Decode(request);
  } catch {
    return fail("malformed");
  }
  const ok = await verify(await importRawPublic(b64url.decode(device.publicKey)), b64url.decode(sig), signed);
  if (!ok) {
    mockBank.log("bad_sig", undefined, "online");
    return fail("bad_sig");
  }
  const r = unpackRequest(request);
  if (!mockBank.users.get(r.mid)?.isMerchant || !Number.isInteger(r.amt) || r.amt <= 0) return fail("malformed");

  const state = mockBank.payOnline(device.userId, r.mid, r.amt, r.rn);
  if (state === "REJECTED") mockBank.log("replay", r.amt, "online");
  return state === "SETTLED_CONFIRMED" ? Response.json({ state }) : fail(state === "REJECTED" ? "replay" : state);
}
