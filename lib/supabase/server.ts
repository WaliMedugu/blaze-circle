import "server-only";
import { createClient } from "@supabase/supabase-js";

/** Service-role client for route handlers. Never import from a client component. */
export function supabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase env vars missing — copy .env.example to .env.local");
  return createClient(url, key, { auth: { persistSession: false } });
}
