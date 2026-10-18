// Seeds the six demo identities from lib/bank/mock.ts into Supabase: auth user + profile +
// funded bank account. Idempotent — safe to re-run between demo sessions.
//
//   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/seed.mjs
//
// Run after `supabase db push` (0001 + 0002). Passwords are demo-only; delete the project
// after InnovateX.

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (Project Settings → API).");
  process.exit(1);
}
const admin = createClient(url, key, { auth: { persistSession: false } });

// Keep in sync with SEED in lib/bank/mock.ts.
const SEED = [
  { email: "wali@blaze.demo", tag: "$wali", name: "Wali", isMerchant: false, balance: 18_250 },
  { email: "joan@blaze.demo", tag: "$joan", name: "Joan", isMerchant: false, balance: 12_000 },
  { email: "helen@blaze.demo", tag: "$helen", name: "Helen", isMerchant: false, balance: 9_000 },
  { email: "timothy@blaze.demo", tag: "$timothy", name: "Timothy", isMerchant: false, balance: 7_500 },
  { email: "mamatee@blaze.demo", tag: "$mamatee", name: "Mama Tee's Kitchen", isMerchant: true, balance: 0 },
  { email: "campusprints@blaze.demo", tag: "$campusprints", name: "Campus Prints", isMerchant: true, balance: 0 },
];

const DEMO_PASSWORD = "blaze-demo-1";
const acctNo = (i) => `205000${String(i + 1).padStart(2, "0")}`; // 8 digits, unique per demo user

async function findUserByEmail(email) {
  let page = 1;
  for (;;) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(error.message);
    const hit = data.users.find((u) => u.email === email);
    if (hit) return hit.id;
    if (data.users.length < 200) return null;
    page += 1;
  }
}

let created = 0;
for (const [i, u] of SEED.entries()) {
  let id;
  const { data: fresh, error: createErr } = await admin.auth.admin.createUser({
    email: u.email,
    password: DEMO_PASSWORD,
    email_confirm: true,
  });
  if (createErr) {
    if (!/already (registered|exists)/i.test(createErr.message)) throw new Error(`${u.email}: ${createErr.message}`);
    id = await findUserByEmail(u.email); // already seeded
  } else {
    id = fresh.user.id;
    created += 1;
  }
  if (!id) throw new Error(`no auth user for ${u.email}`);

  const { error: profileErr } = await admin
    .from("profiles")
    .upsert({ id, tag: u.tag, display_name: u.name, is_merchant: u.isMerchant }, { onConflict: "id" });
  if (profileErr) throw new Error(`profile ${u.tag}: ${profileErr.message}`);

  const { error: acctErr } = await admin
    .from("bank_accounts")
    .upsert({ user_id: id, acct_no: acctNo(i), balance: u.balance, lien_total: 0 }, { onConflict: "user_id" });
  if (acctErr) throw new Error(`account ${u.tag}: ${acctErr.message}`);

  console.log(`✓ ${u.tag.padEnd(14)} ${u.name} · ₦${u.balance.toLocaleString()} · ${acctNo(i)}`);
}
console.log(`\n${SEED.length} demo users ready (${created} new auth users). Password: ${DEMO_PASSWORD}`);
