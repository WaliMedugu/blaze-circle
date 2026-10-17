import { connection } from "next/server";
import { mockBank } from "@/lib/bank/mock";

/** Risk Console feed (Day 3 UI polls this). */
export async function GET() {
  await connection(); // live state, never prerender
  return Response.json({ events: mockBank.events.slice(0, 50) }, { headers: { "Cache-Control": "no-store" } });
}
