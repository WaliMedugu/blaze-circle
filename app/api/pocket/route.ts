import { mockBank } from "@/lib/bank/mock";
import { b64url, packCert } from "@/lib/relay/encoding";
import { issueCert } from "@/lib/relay/protocol";
import { MAX_POCKET } from "@/lib/relay/rules";
import { bankKeys, fail, nowS } from "@/lib/server/bank-key";

/** Lock `amount` into a Blaze Pocket and return the bank-signed certificate for this device. */
export async function POST(req: Request) {
  const { userId, deviceId, amount } = await req.json();
  if (!Number.isInteger(amount) || amount < 1 || amount > MAX_POCKET) return fail("bad_amount");
  const device = mockBank.devices.get(deviceId);
  const user = mockBank.users.get(userId);
  if (!device || device.userId !== userId || !user) return fail("unknown_device");

  const now = nowS();
  const { priv } = await bankKeys();
  const { cert, bankSig } = await issueCert(
    priv,
    { cid: crypto.randomUUID(), uid: userId, tag: user.tag, did: deviceId, pk: b64url.decode(device.publicKey), lim: amount },
    now,
  );
  try {
    // Lien first, cert only handed out if the money is really locked.
    await mockBank.placePocketLien({ userId, deviceId, certId: cert.cid, limit: amount, expiresAt: new Date(cert.exp * 1000) });
  } catch (e) {
    return fail((e as Error).message);
  }
  return Response.json({ cert: packCert(cert, bankSig) });
}
