import { getBank } from "@/lib/bank";
import { fail } from "@/lib/server/bank-key";

export async function POST(req: Request) {
  const { userId, publicKey } = await req.json();
  if (typeof publicKey !== "string" || publicKey.length < 80) return fail("bad_public_key");
  try {
    return Response.json({ deviceId: await getBank().registerDevice(userId, publicKey) });
  } catch (e) {
    return fail((e as Error).message);
  }
}
