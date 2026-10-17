-- Blaze-Grid Day 1 schema. MockBank lives in bank_accounts + ledger_entries (swap for EcobankAdapter later).
-- Signature checks happen in TypeScript (lib/relay) before calling these functions — Postgres has no ECDSA verify.
-- Server routes use the service-role key; clients only get the read policies at the bottom.

create extension if not exists pgcrypto;

create table profiles (
  id uuid primary key references auth.users on delete cascade,
  tag text unique not null check (tag ~ '^\$[a-z0-9_]{3,20}$'),
  display_name text not null,
  is_merchant boolean not null default false,
  trust_score int not null default 50 check (trust_score between 0 and 100),
  created_at timestamptz not null default now()
);

-- Mock Ecobank account. available = balance - lien_total.
create table bank_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique not null references profiles on delete cascade,
  acct_no text unique not null,
  balance bigint not null default 0,
  lien_total bigint not null default 0 check (lien_total >= 0),
  check (lien_total <= balance or balance < 0) -- balance < 0 only via fraud recovery
);

create table ledger_entries (
  id bigserial primary key,
  account_id uuid not null references bank_accounts,
  delta bigint not null,
  kind text not null, -- topup | pocket_lien | pocket_release | voucher_debit | voucher_credit | online_pay | loan | recovery
  ref_id text,
  created_at timestamptz not null default now()
);

create table devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles on delete cascade,
  public_key text not null, -- base64url raw P-256
  revoked boolean not null default false,
  created_at timestamptz not null default now()
);

create table pockets (
  cert_id uuid primary key,
  user_id uuid not null references profiles,
  device_id uuid not null references devices,
  limit_amount int not null check (limit_amount between 1 and 5000),
  spent int not null default 0, -- merchant-settled
  held int not null, -- lien still locked for this pocket
  reported int not null default 0, -- payer-reported spend, may arrive before the merchant syncs
  expires_at timestamptz not null,
  status text not null default 'active' check (status in ('active', 'superseded', 'released', 'revoked')),
  created_at timestamptz not null default now()
);
create unique index one_active_pocket_per_device on pockets (device_id) where status = 'active';

create table vouchers (
  id bigserial primary key,
  cert_id uuid not null references pockets,
  ctr int not null check (ctr between 1 and 3),
  payer_id uuid not null references profiles,
  merchant_id uuid not null references profiles,
  amount int not null check (amount > 0),
  nonce text not null,
  payload text not null, -- the raw QR, kept as cryptographic evidence
  state text not null check (state in ('RECEIVED_VALIDATED', 'SETTLED_CONFIRMED', 'REJECTED')),
  reject_reason text,
  fraud_flag text, -- double_spend | overspend: merchant still paid, recovered from payer
  submitted_by text not null check (submitted_by in ('merchant', 'payer', 'online')),
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  unique (cert_id, ctr, nonce)
);
create index on vouchers (cert_id, ctr);

create table payer_reports (
  cert_id uuid references pockets,
  ctr int,
  nonce text,
  amount int not null,
  created_at timestamptz not null default now(),
  primary key (cert_id, ctr, nonce)
);

-- Live Risk Console feed, including rejected attempts that never become voucher rows.
create table relay_events (
  id bigserial primary key,
  cert_id uuid,
  ctr int,
  amount int,
  outcome text not null, -- a voucher state or a RejectReason from lib/relay/types.ts
  detail jsonb,
  created_at timestamptz not null default now()
);

create table proof_events (
  id bigserial primary key,
  user_id uuid not null references profiles,
  kind text not null, -- payment | received | repayment | approval | pledge
  amount int,
  meta jsonb,
  created_at timestamptz not null default now()
);

-- Circles (Day 3 UI, schema now so nobody migrates twice).
create table circles (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid not null references profiles,
  created_at timestamptz not null default now()
);
create table circle_members (
  circle_id uuid references circles on delete cascade,
  user_id uuid references profiles,
  pledge_amount int not null default 0 check (pledge_amount >= 0),
  joined_at timestamptz not null default now(),
  primary key (circle_id, user_id)
);
create table loans (
  id uuid primary key default gen_random_uuid(),
  circle_id uuid not null references circles,
  borrower_id uuid not null references profiles,
  amount int not null check (amount between 1 and 30000),
  purpose text,
  status text not null default 'requested' check (status in ('requested', 'disbursed', 'repaid', 'defaulted', 'declined')),
  due_at timestamptz,
  created_at timestamptz not null default now()
);
create table loan_approvals (
  loan_id uuid references loans on delete cascade,
  approver_id uuid references profiles,
  approved boolean not null,
  created_at timestamptz not null default now(),
  primary key (loan_id, approver_id)
);
create table ious (
  id bigserial primary key,
  debtor_id uuid not null references profiles,
  creditor_id uuid not null references profiles,
  amount int not null check (amount > 0),
  reason text,
  settled boolean not null default false,
  created_at timestamptz not null default now()
);

-- ── Functions ──────────────────────────────────────────────────────────────

-- Lock `p_limit` of the payer's balance into a new pocket (call after signing the cert in TS).
create or replace function issue_pocket(p_user uuid, p_device uuid, p_cert uuid, p_limit int, p_expires timestamptz)
returns void language plpgsql as $$
declare
  acct bank_accounts;
  old pockets;
  keep int;
begin
  select * into acct from bank_accounts where user_id = p_user for update;
  -- Renewing: keep lien only for spend the payer reported but merchants haven't settled yet.
  for old in select * from pockets where device_id = p_device and status = 'active' for update loop
    keep := greatest(0, least(old.limit_amount, old.reported) - old.spent);
    acct.lien_total := acct.lien_total - (old.held - keep);
    update pockets set held = keep, status = 'superseded' where cert_id = old.cert_id;
  end loop;
  update bank_accounts set lien_total = acct.lien_total where id = acct.id;
  if acct.balance - acct.lien_total < p_limit then raise exception 'insufficient_funds'; end if;
  insert into pockets (cert_id, user_id, device_id, limit_amount, held, expires_at) values (p_cert, p_user, p_device, p_limit, p_limit, p_expires);
  update bank_accounts set lien_total = lien_total + p_limit where id = acct.id;
  insert into ledger_entries (account_id, delta, kind, ref_id) values (acct.id, 0, 'pocket_lien', p_cert::text);
end $$;

create or replace function release_pocket(p_cert uuid) returns void language plpgsql as $$
declare p pockets;
begin
  select * into p from pockets where cert_id = p_cert for update;
  if p.status in ('released', 'revoked') then return; end if;
  update bank_accounts set lien_total = lien_total - p.held where user_id = p.user_id;
  update pockets set held = 0, status = 'released' where cert_id = p_cert;
end $$;

-- Atomic, idempotent settlement of a voucher that already passed validateUpload() in TS.
-- Policy (plan §3.4): a valid voucher accepted by a merchant is ALWAYS paid. Overspend or a
-- double-signed counter is recovered from the payer's main balance and the pocket is revoked.
create or replace function settle_voucher(
  p_cert uuid, p_ctr int, p_merchant uuid, p_amount int, p_nonce text, p_payload text, p_submitted_by text
) returns text language plpgsql as $$
declare
  p pockets;
  existing vouchers;
  flag text := null;
  from_pocket int;
  payer_acct uuid;
  merchant_acct uuid;
begin
  select * into p from pockets where cert_id = p_cert for update; -- serialises all settlements per pocket
  if not found then
    insert into relay_events (cert_id, ctr, amount, outcome) values (p_cert, p_ctr, p_amount, 'unknown_cert');
    return 'REJECTED';
  end if;

  select * into existing from vouchers where cert_id = p_cert and ctr = p_ctr limit 1;
  if found and existing.nonce = p_nonce then
    return existing.state; -- same voucher uploaded twice (merchant + payer, or a retry): idempotent
  elsif found then
    flag := 'double_spend'; -- same counter signed for two sales: cryptographic proof of a cloned pocket
  end if;

  -- Only the merchant's upload moves money; a payer upload is an early-warning record.
  if p_submitted_by = 'payer' then
    insert into payer_reports (cert_id, ctr, nonce, amount) values (p_cert, p_ctr, p_nonce, p_amount) on conflict do nothing;
    if found then
      update pockets set reported = reported + p_amount where cert_id = p_cert;
      insert into relay_events (cert_id, ctr, amount, outcome) values (p_cert, p_ctr, p_amount, 'payer_reported');
    end if;
    return 'PENDING';
  end if;

  if flag is null and p.spent + p_amount > p.limit_amount then flag := 'overspend'; end if;
  from_pocket := least(p_amount, p.held);

  select id into payer_acct from bank_accounts where user_id = p.user_id for update;
  select id into merchant_acct from bank_accounts where user_id = p_merchant for update;

  update bank_accounts set balance = balance - p_amount, lien_total = lien_total - from_pocket where id = payer_acct;
  update bank_accounts set balance = balance + p_amount where id = merchant_acct;
  update pockets set spent = spent + p_amount, held = held - from_pocket where cert_id = p_cert;
  if flag is not null then
    -- release whatever is still locked, revoke offline mode
    update bank_accounts set lien_total = lien_total - (p.held - from_pocket) where id = payer_acct;
    update pockets set held = 0, status = 'revoked' where cert_id = p_cert;
    update devices set revoked = true where id = p.device_id;
  end if;

  insert into ledger_entries (account_id, delta, kind, ref_id) values
    (payer_acct, -p_amount, case when flag is null then 'voucher_debit' else 'recovery' end, p_cert || ':' || p_ctr),
    (merchant_acct, p_amount, 'voucher_credit', p_cert || ':' || p_ctr);
  insert into vouchers (cert_id, ctr, payer_id, merchant_id, amount, nonce, payload, state, fraud_flag, submitted_by, settled_at)
    values (p_cert, p_ctr, p.user_id, p_merchant, p_amount, p_nonce, p_payload, 'SETTLED_CONFIRMED', flag, p_submitted_by, now());
  insert into relay_events (cert_id, ctr, amount, outcome, detail)
    values (p_cert, p_ctr, p_amount, 'SETTLED_CONFIRMED', jsonb_build_object('fraud_flag', flag));
  insert into proof_events (user_id, kind, amount) values (p.user_id, 'payment', p_amount), (p_merchant, 'received', p_amount);
  return 'SETTLED_CONFIRMED';
end $$;

-- ── RLS: clients read their own data; all writes go through server routes (service role). ──
alter table profiles enable row level security;
alter table bank_accounts enable row level security;
alter table ledger_entries enable row level security;
alter table devices enable row level security;
alter table pockets enable row level security;
alter table vouchers enable row level security;
alter table relay_events enable row level security;
alter table proof_events enable row level security;
alter table circles enable row level security;
alter table circle_members enable row level security;
alter table loans enable row level security;
alter table loan_approvals enable row level security;
alter table ious enable row level security;

create policy "profiles readable by signed-in users" on profiles for select to authenticated using (true);
create policy "own account" on bank_accounts for select to authenticated using (user_id = auth.uid());
create policy "own pockets" on pockets for select to authenticated using (user_id = auth.uid());
create policy "own vouchers" on vouchers for select to authenticated using (payer_id = auth.uid() or merchant_id = auth.uid());
create policy "own proof" on proof_events for select to authenticated using (user_id = auth.uid());
-- relay_events is public for the judge console (contains no names, only ids and amounts)
create policy "console feed" on relay_events for select to anon, authenticated using (true);

alter publication supabase_realtime add table relay_events, vouchers;
