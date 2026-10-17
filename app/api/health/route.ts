export function GET() {
  return Response.json({ ok: true, t: Date.now() }, { headers: { "Cache-Control": "no-store" } });
}
