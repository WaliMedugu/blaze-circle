import { mockBank } from "@/lib/bank/mock";
import { fail } from "@/lib/server/bank-key";

export function GET(req: Request) {
  const me = mockBank.me(new URL(req.url).searchParams.get("userId") ?? "");
  return me ? Response.json(me, { headers: { "Cache-Control": "no-store" } }) : fail("unknown_user", 404);
}
