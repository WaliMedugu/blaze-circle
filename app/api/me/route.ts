import { getBank } from "@/lib/bank";
import { fail } from "@/lib/server/bank-key";

export async function GET(req: Request) {
  const userId = new URL(req.url).searchParams.get("userId") ?? "";
  const me = await getBank().me(userId);
  return me ? Response.json(me, { headers: { "Cache-Control": "no-store" } }) : fail("unknown_user", 404);
}
