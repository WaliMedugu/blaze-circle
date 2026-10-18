# Blaze-Grid Database Plan

Status: plan for the Postgres/Supabase cutover. Baseline schema is `supabase/migrations/0001_init.sql`.
All amounts are **whole Naira** (`int`/`bigint`) because the wire protocol (`lib/relay/types.ts`)
signs whole-Naira amounts — the DB must match what the signature covers.

---

## 1. Where we are today

| Layer | State |
|---|---|
| `supabase/migrations/0001_init.sql` | 13 tables, `issue_pocket` / `release_pocket` / `settle_voucher`, RLS read policies. **Never executed by app code.** |
| `lib/supabase/server.ts` | Service-role client exists, imported by nothing. |
| `lib/bank/mock.ts` | **Actual source of truth**: in-memory Maps on `globalThis`. Loses all state on restart and per-instance on Vercel. |
| `app/api/*` | Every route (`pocket`, `vouchers`, `pay/online`, `me`, `devices`, `events`, `requests`, `demo/users`) calls `mockBank` directly. |
| Client (`lib/offline/db.ts`) | IndexedDB — device keys, cert, outbox. Untouched by this plan (browser-local by design). |

The architecture already anticipates the swap: all routes reach the bank only through
`lib/bank/adapter.ts` (`EcobankAdapter`). We implement a `SupabaseBank` behind that seam and flip
one env var.

## 2. Target architecture

```
app/api/*  ──►  SupabaseBank (lib/bank/supabase.ts, implements EcobankAdapter)
                    │  service-role key, server-only
                    ▼
              Postgres ── issue_pocket / release_pocket / settle_voucher / pay_online
                    │     (row locks + atomic money movement in plpgsql)
                    ├── relay_events + vouchers ──► Supabase Realtime ──► Risk Console
                    └── RLS: clients SELECT their own rows; no client writes ever
```

Rules that do not change:

- ECDSA P-256 signature checks stay in TypeScript (`lib/relay`) — Postgres cannot verify ECDSA.
  Routes call `validateUpload()` / `verify()` **before** any DB function.
- All writes go through server routes with the service role. Clients get SELECT-only RLS.
- `settle_voucher` policy (plan §3.4) is unchanged: a valid voucher accepted by a merchant is
  **always paid**; overspend/double-spend is recovered from the payer's main balance.

## 3. Existing schema (0001) — reference

| Table | Purpose | Key columns |
|---|---|---|
| `profiles` | Identity ($tag, trust score) | `id → auth.users`, `tag ~ '^\$[a-z0-9_]{3,20}$'`, `is_merchant` |
| `bank_accounts` | Mock Ecobank account | `balance`, `lien_total`; available = balance − lien_total |
| `ledger_entries` | Append-only money trail | `delta`, `kind` (topup / pocket_lien / pocket_release / voucher_debit / voucher_credit / online_pay / loan / recovery), `ref_id` |
| `devices` | Per-phone P-256 key | `public_key` (base64url raw), `revoked` |
| `pockets` | Liened offline spending limit | `limit_amount ≤ 5000`, `spent`, `held`, `reported`, one active per device |
| `vouchers` | Settled offline payments | `unique (cert_id, ctr, nonce)` = replay/double-spend proof; `state`, `fraud_flag` |
| `payer_reports` | Early warning uploaded by payer | PK `(cert_id, ctr, nonce)` |
| `relay_events` | Risk Console feed | `outcome` (voucher state or RejectReason), `detail jsonb`; realtime-enabled |
| `proof_events` | Social proof feed | kind: payment / received / repayment / approval / pledge |
| `payment_requests` | **0002** — online charge requests, replay guard (`rn`) | PK `rn`; `payer_id`/`settled_at` null until an online payment claims it |
| `circles`, `circle_members`, `loans`, `loan_approvals`, `ious` | Day-3 peer credit | schema in place, UI pending |

## 4. Gap analysis — MockBank state vs. Postgres

| # | MockBank holds | Postgres has | Action |
|---|---|---|---|
| G1 | `paidRequests` (rn → payer tag; replay guard + merchant poll) | **nothing** | New table `payment_requests` + `pay_online()` (migration 0002) |
| G2 | `SEED` users (4 payers + 2 merchants, starting balances) | **nothing** | `scripts/seed.mjs` via Admin API (profiles FK → `auth.users`) |
| G3 | `devices` Map with `revoked` + ownership check in `placePocketLien` | `devices` table | Covered, but `issue_pocket()` does **not** check device ownership/revocation — add in 0002 |
| G4 | `me()` activity feed (last 30 payments, direction, counterparty) | derivable from `vouchers` + `payment_requests` + `ledger_entries` | RPC `my_activity()` (migration 0002) |
| G5 | `events` ring buffer of 200, `detail` as string | `relay_events`, `detail` is `jsonb` | Covered; API must normalize `detail` to a string for the existing Risk Console UI |
| G6 | `getAccount` synthesises `acct_no` | `bank_accounts.acct_no` column exists | Generate real account numbers at seed time |
| G7 | `pocket_issued` logged with user tag | — | Log from the pocket route after `issue_pocket()` succeeds |
| G8 | — | `payer_reports` **not in the RLS enable list** (0001 lines 244–256) | Fix: enable RLS (it is readable by anon today via PostgREST) |

## 5. Migration `0002_supabase_bank.sql` — shipped

Implemented in `supabase/migrations/0002_supabase_bank.sql`. The draft below informed it; two
adjustments landed in the final SQL: `my_activity()` returns `ref` (a display key) and
`counterparty` as a **resolved display name** (join to `profiles`) instead of a raw uuid, and
`pay_online()` validates payer/merchant up front. See the migration file for the source of truth.

```sql
-- Closes gaps G1/G3/G4/G8 between lib/bank/mock.ts and the 0001 schema.

-- G8: payer_reports was missed in 0001's RLS pass.
alter table payer_reports enable row level security;

-- G1: online charge-request settlement (replaces mockBank.paidRequests).
create table payment_requests (
  rn text primary key check (rn ~ '^[0-9a-f]{32}$'), -- ChargeRequest.rn
  merchant_id uuid not null references profiles,
  payer_id uuid references profiles,
  amount int not null check (amount > 0),
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  check (payer_id is null or settled_at is not null)
);
create index on payment_requests (merchant_id, created_at desc);
alter table payment_requests enable row level security;
create policy "merchant sees own requests" on payment_requests
  for select to authenticated using (merchant_id = auth.uid() or payer_id = auth.uid());

-- G3: issue_pocket must refuse revoked/foreign devices (mock.ts already does).
create or replace function issue_pocket(p_user uuid, p_device uuid, p_cert uuid, p_limit int, p_expires timestamptz)
returns void language plpgsql as $$
declare
  acct bank_accounts;
  old pockets;
  keep int;
begin
  perform 1 from devices where id = p_device and user_id = p_user and not revoked;
  if not found then raise exception 'unknown_device'; end if;
  select * into acct from bank_accounts where user_id = p_user for update;
  for old in select * from pockets where device_id = p_device and status = 'active' for update loop
    keep := greatest(0, least(old.limit_amount, old.reported) - old.spent);
    acct.lien_total := acct.lien_total - (old.held - keep);
    update pockets set held = keep, status = 'superseded' where cert_id = old.cert_id;
  end loop;
  update bank_accounts set lien_total = acct.lien_total where id = acct.id;
  if acct.balance - acct.lien_total < p_limit then raise exception 'insufficient_funds'; end if;
  insert into pockets (cert_id, user_id, device_id, limit_amount, held, expires_at)
    values (p_cert, p_user, p_device, p_limit, p_limit, p_expires);
  update bank_accounts set lien_total = lien_total + p_limit where id = acct.id;
  insert into ledger_entries (account_id, delta, kind, ref_id) values (acct.id, 0, 'pocket_lien', p_cert::text);
  insert into relay_events (cert_id, amount, outcome, detail)
    values (p_cert, p_limit, 'pocket_issued', jsonb_build_object('uid', p_user));
end $$;

-- G1: atomic, idempotent online payment. Mirrors MockBank.payOnline().
create or replace function pay_online(p_payer uuid, p_merchant uuid, p_amount int, p_rn text)
returns text language plpgsql as $$
declare
  payer_acct bank_accounts;
  merchant_acct uuid;
begin
  if not exists (select 1 from profiles where id = p_merchant and is_merchant) then return 'malformed'; end if;

  -- Claim the nonce: first claim settles, a second is a replay.
  insert into payment_requests (rn, merchant_id, amount) values (p_rn, p_merchant, p_amount)
    on conflict (rn) do nothing;
  update payment_requests set payer_id = p_payer, settled_at = now() where rn = p_rn and payer_id is null;
  if not found then
    insert into relay_events (amount, outcome, detail) values (p_amount, 'replay', jsonb_build_object('path', 'online', 'rn', p_rn));
    return 'REJECTED';
  end if;

  select * into payer_acct from bank_accounts where user_id = p_payer for update;
  if payer_acct.balance - payer_acct.lien_total < p_amount then
    update payment_requests set payer_id = null, settled_at = null where rn = p_rn; -- un-claim on failure
    return 'insufficient_funds';
  end if;
  select id into merchant_acct from bank_accounts where user_id = p_merchant for update;

  update bank_accounts set balance = balance - p_amount where id = payer_acct.id;
  update bank_accounts set balance = balance + p_amount where id = merchant_acct;
  insert into ledger_entries (account_id, delta, kind, ref_id) values
    (payer_acct.id, -p_amount, 'online_pay', p_rn),
    (merchant_acct,      p_amount, 'online_pay', p_rn);
  insert into relay_events (amount, outcome, detail) values (p_amount, 'SETTLED_CONFIRMED', jsonb_build_object('path', 'online'));
  insert into proof_events (user_id, kind, amount) values (p_payer, 'payment', p_amount), (p_merchant, 'received', p_amount);
  return 'SETTLED_CONFIRMED';
end $$;

-- G4: /api/me activity feed, one round trip.
create or replace function my_activity(p_user uuid, p_limit int default 30)
returns table (amount int, mode text, direction text, counterparty uuid, at timestamptz)
language sql stable as $$
  select v.amount, 'offline'::text as mode, 'out'::text as direction, v.merchant_id as counterparty, v.created_at as at
    from vouchers v where v.payer_id = p_user
  union all
  select v.amount, 'offline', 'in', v.payer_id, v.created_at
    from vouchers v where v.merchant_id = p_user
  union all
  select r.amount, 'online', 'out', r.merchant_id, r.settled_at
    from payment_requests r where r.payer_id = p_user
  union all
  select r.amount, 'online', 'in', r.payer_id, r.settled_at
    from payment_requests r where r.merchant_id = p_user
  order by at desc nulls last limit p_limit;
$$;

-- Read-path indexes.
create index if not exists ledger_entries_account_idx on ledger_entries (account_id, created_at desc);
create index if not exists vouchers_payer_idx   on vouchers (payer_id, created_at desc);
create index if not exists vouchers_merchant_idx on vouchers (merchant_id, created_at desc);
create index if not exists relay_events_recent_idx on relay_events (created_at desc);
create index if not exists proof_events_user_idx on proof_events (user_id, created_at desc);
create index if not exists pockets_user_active_idx on pockets (user_id) where status = 'active';
```

## 6. Adapter mapping (`SupabaseBank implements EcobankAdapter`)

| Adapter method | Backing call |
|---|---|
| `getAccount(userId)` | `select acct_no, balance, lien_total from bank_accounts where user_id = ?` |
| `placePocketLien(...)` | `rpc('issue_pocket', ...)` (cert id passed from the route, which signs first) |
| `releasePocket(certId)` | `rpc('release_pocket', ...)` |
| `settleVoucher(...)` | `rpc('settle_voucher', ...)` → returns the state string verbatim |
| *(extra)* `payOnline(...)` | `rpc('pay_online', ...)` |
| *(extra)* `registerDevice(...)` | `insert into devices ... returning id` (+ ownership/revoked checks in TS, mirroring mock) |
| *(extra)* `requestStatus(rn)` | `select payer_id, amount from payment_requests where rn = ?` |
| *(extra)* `me(userId)` | `rpc('my_activity')` + account select |
| *(extra)* `log(...)` | `insert into relay_events ...` |
| *(extra)* `listDemoUsers()` | `select profiles + bank_accounts join` (until real onboarding lands) |

Implementation notes:

- Amounts cross the wire as JS `number` whole Naira — map 1:1 to Postgres `int`. No unit conversion.
- `relay_events.detail` is `jsonb` in PG vs `string` in MockBank: normalise in the route
  (`typeof detail === "object" ? detail : { note: detail }`) so the console UI needs no change.
- `settle_voucher` and `pay_online` are the only places money moves. Both write `ledger_entries`
  in the same transaction; the balance columns are a cache of the ledger, never edited elsewhere.

## 7. Seed & demo data (G2, G6)

`profiles.id → auth.users`, so seeding must create real auth users. **Do not** hand-insert into
`auth.users`. Add `scripts/seed.mjs`:

1. `SUPABASE_SERVICE_ROLE_KEY` → `auth.admin.createUser({ email, password, email_confirm: true })`
   for the six SEED identities from `lib/bank/mock.ts` (`$wali`, `$joan`, `$helen`, `$timothy`,
   `$mamatee`, `$campusprints`).
2. Insert `profiles` (tag, display_name, `is_merchant`) and `bank_accounts`
   (`acct_no` e.g. `20500` + index, `balance` = seed balance, `lien_total` = 0).
3. Idempotent: `upsert` on `tag` / `user_id`; safe to re-run between demo sessions.
4. Run with `node scripts/seed.mjs` after `supabase db push`.

## 8. Cutover sequence

| Phase | Work | Done when |
|---|---|---|
| **0 — Baseline** | `supabase link` + `supabase db push` (0001), then 0002. Smoke-test each RPC in the SQL editor. | Tables + functions exist |
| **1 — Seed** | `scripts/seed.mjs`; verify `/api/demo/users` data exists in the dashboard. | Six funded demo users |
| **2 — Adapter** ✅ | `lib/bank/supabase.ts` + `getBank()` (`BANK_BACKEND=mock\|supabase`); all eight routes repointed. Request/response shapes unchanged. | `npm test` green |
| **3 — Verify** | Run the README payment loop (both tabs) against `BANK_BACKEND=supabase`: top-up → pocket → offline charge → settle; then fraud drill (replayed voucher → `double_spend`, merchant still paid, device revoked); then online path replay. | Ledger balances match pocket/voucher totals; Risk Console streams via Realtime |
| **4 — Deploy** | Vercel env: `BANK_BACKEND=supabase` + Supabase keys. Keep `mock` as dev fallback. | Demo survives restarts and multi-instance |

Status: Phases 0–2 are code-complete. Phase 0/1 need a Supabase project (URL + service-role key
in `.env.local`); Phase 3 verification runs once those exist.

Rollback at any phase = set `BANK_BACKEND=mock`; no schema rollback needed (0001/0002 are additive).

## 9. Ops

- **Backups:** Supabase automatic daily backups; enable PITR before the InnovateX demo — the
  ledger is append-only but `bank_accounts` is mutable state.
- **Retention:** `relay_events` / `proof_events` grow unbounded — cap at 90 days
  (`pg_cron` delete) once past the event; `vouchers.payload` (raw QR evidence) is kept indefinitely.
- **Realtime:** `relay_events` and `vouchers` are already in `supabase_realtime`. Optional Phase 5:
  the Risk Console subscribes directly (anon, read-only) instead of polling `/api/events`.
- **Accounting invariant** (worth a nightly check query):
  `bank_accounts.balance = seed_balance + Σ ledger_entries.delta` and
  `lien_total = Σ active/held pockets`. Any drift is a bug in a settle path.
- **Security review:** service-role key only in server code (`lib/supabase/server.ts` already
  guards this); `relay_events` stays public-by-policy (ids and amounts only — keep it that way);
  never put tags/display names in `relay_events.detail`.

## 10. Verification checklist

- [ ] `payer_reports` RLS enabled (0002) — anon key returns 0 rows.
- [ ] `issue_pocket` rejects a revoked or foreign device.
- [ ] Double upload of the same voucher → both callers get `SETTLED_CONFIRMED`, one ledger row.
- [ ] Counter reuse (same `ctr`, new nonce) → `fraud_flag = 'double_spend'`, merchant paid, payer recovered, `devices.revoked = true`.
- [ ] Overspend → `fraud_flag = 'overspend'`, merchant paid, pocket revoked.
- [ ] Payer upload first → `PENDING`, `pockets.reported` bumped; merchant upload later → settles once.
- [ ] `pay_online` replay of a settled `rn` → `REJECTED`; unclaimed `insufficient_funds` leaves the `rn` claimable again.
- [ ] Server restart / second Vercel instance: balances and outbox sync unchanged.
