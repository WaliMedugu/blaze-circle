import { connection } from "next/server";
import { mockBank } from "@/lib/bank/mock";

// Demo identity picker. Replaced by real onboarding (phone OTP + $BlazeTag) later.
export async function GET() {
  await connection();
  return Response.json({ users: [...mockBank.users.values()] });
}
