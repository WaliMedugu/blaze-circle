import { connection } from "next/server";
import { bankKeys } from "@/lib/server/bank-key";

/** Phones cache this while online so merchants can verify pocket certs offline. */
export async function GET() {
  await connection(); // request-time only; never prerender a key at build
  return Response.json({ publicKey: (await bankKeys()).pubB64 });
}
