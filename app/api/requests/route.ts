import { mockBank } from "@/lib/bank/mock";

/** Merchant polls this while showing a request QR, so an online payment needs no second scan. */
export function GET(req: Request) {
  const rn = new URL(req.url).searchParams.get("rn") ?? "";
  return Response.json(mockBank.requestStatus(rn), { headers: { "Cache-Control": "no-store" } });
}
