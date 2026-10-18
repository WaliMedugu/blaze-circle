import { getBank } from "@/lib/bank";

/** Merchant polls this while showing a request QR, so an online payment needs no second scan. */
export async function GET(req: Request) {
  const rn = new URL(req.url).searchParams.get("rn") ?? "";
  return Response.json(await getBank().requestStatus(rn), { headers: { "Cache-Control": "no-store" } });
}
