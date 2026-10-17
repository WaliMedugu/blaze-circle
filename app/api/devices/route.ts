import { mockBank } from "@/lib/bank/mock";
import { fail } from "@/lib/server/bank-key";

export async function POST(req: Request) {
  const { userId, publicKey } = await req.json();
  if (typeof publicKey !== "string" || publicKey.length < 80) return fail("bad_public_key");
  try {
    return Response.json({ deviceId: mockBank.registerDevice(userId, publicKey) });
  } catch (e) {
    return fail((e as Error).message);
  }
}
