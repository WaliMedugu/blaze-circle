import { connection } from "next/server";
import { getBank } from "@/lib/bank";

/** Risk Console feed (Day 3 UI polls this). */
export async function GET() {
  await connection(); // live state, never prerender
  return Response.json({ events: await getBank().getEvents(50) }, { headers: { "Cache-Control": "no-store" } });
}
