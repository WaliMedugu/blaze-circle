import { connection } from "next/server";
import { getBank } from "@/lib/bank";

// Demo identity picker. Replaced by real onboarding (phone OTP + $BlazeTag) later.
export async function GET() {
  await connection();
  return Response.json({ users: await getBank().listDemoUsers() });
}
