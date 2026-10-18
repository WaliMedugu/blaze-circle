-- Blaze-Grid 0002: closes the gaps between lib/bank/mock.ts (in-memory) and Postgres (plan docs/DATABASE_PLAN.md §5).
-- G1 payment_requests + pay_online (replaces mockBank.paidRequests)
-- G3 issue_pocket device ownership/revocation check
-- G4 my_activity() for /api/me
-- G8 payer_reports RLS

-- G8: payer_reports was missed in 0001's RLS pass (readable by anon via PostgREST today).
alter table payer_reports enable row level security;

-- G1: online charge-request settlement, keyed by ChargeRequest.rn.
create table payment_requests (
  rn text primary key check (rn ~ '^[0-9a-f]{32}$'),
  merchant_id uuid not null references profiles,
  payer_id uuid references profiles,
  amount int not null check (amount > 0),
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  check (payer_id is null or settled_at is not null)
);
create index payment_requests_merchant_idx on payment_requests (merchant_id, created_at desc);
alter table payment_requests enable row level security;
create policy "own payment requests" on payment_requests
  for select to authenticated using (merchant_id = auth.uid() or payer_id = auth.uid());

-- G3: issue_pocket must refuse revoked/foreign devices (mock.ts placePocketLien already does),
-- and it logs the issuance to the Risk Console feed like mockBank.log("pocket_issued").
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
  -- Renewing: keep lien only for spend the payer reported but merchants haven't settled yet.
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

-- G1: atomic, idempotent online payment. Mirrors MockBank.payOnline() (nonce = rn).
create or replace function pay_online(p_payer uuid, p_merchant uuid, p_amount int, p_rn text)
returns text language plpgsql as $$
declare
  payer_acct bank_accounts;
  merchant_acct uuid;
begin
  if p_amount <= 0 then return 'malformed'; end if;
  if not exists (select 1 from profiles where id = p_merchant and is_merchant) then return 'malformed'; end if;
  if not exists (select 1 from bank_accounts where user_id = p_payer) then return 'unknown_user'; end if;

  -- Claim the nonce: the first claim settles; a second claim is a replay.
  insert into payment_requests (rn, merchant_id, amount) values (p_rn, p_merchant, p_amount)
    on conflict (rn) do nothing;
  update payment_requests set payer_id = p_payer, settled_at = now() where rn = p_rn and payer_id is null;
  if not found then
    insert into relay_events (amount, outcome, detail)
      values (p_amount, 'replay', jsonb_build_object('path', 'online', 'rn', p_rn));
    return 'REJECTED';
  end if;

  select * into payer_acct from bank_accounts where user_id = p_payer for update;
  if payer_acct.balance - payer_acct.lien_total < p_amount then
    update payment_requests set payer_id = null, settled_at = null where rn = p_rn; -- un-claim, retryable
    return 'insufficient_funds';
  end if;
  select id into merchant_acct from bank_accounts where user_id = p_merchant for update;

  update bank_accounts set balance = balance - p_amount where id = payer_acct.id;
  update bank_accounts set balance = balance + p_amount where id = merchant_acct;
  insert into ledger_entries (account_id, delta, kind, ref_id) values
    (payer_acct.id, -p_amount, 'online_pay', p_rn),
    (merchant_acct,      p_amount, 'online_pay', p_rn);
  insert into relay_events (amount, outcome, detail)
    values (p_amount, 'SETTLED_CONFIRMED', jsonb_build_object('path', 'online'));
  insert into proof_events (user_id, kind, amount) values (p_payer, 'payment', p_amount), (p_merchant, 'received', p_amount);
  return 'SETTLED_CONFIRMED';
end $$;

-- G4: /api/me activity feed in one round trip. counterparty resolved to a display name here
-- so the route stays a thin mapper (UI shows names, never raw ids).
create or replace function my_activity(p_user uuid, p_limit int default 30)
returns table (
  ref text,
  amount int,
  mode text,
  direction text,
  counterparty text,
  at timestamptz
) language sql stable as $$
  select v.cert_id::text || ':' || v.ctr as ref, v.amount, 'offline' as mode, 'out' as direction,
         mp.display_name as counterparty, coalesce(v.settled_at, v.created_at) as at
    from vouchers v join profiles mp on mp.id = v.merchant_id
   where v.payer_id = p_user
  union all
  select v.cert_id::text || ':' || v.ctr, v.amount, 'offline', 'in',
         pp.display_name, coalesce(v.settled_at, v.created_at)
    from vouchers v join profiles pp on pp.id = v.payer_id
   where v.merchant_id = p_user
  union all
  select r.rn, r.amount, 'online', 'out', mp.display_name, r.settled_at
    from payment_requests r join profiles mp on mp.id = r.merchant_id
   where r.payer_id = p_user and r.settled_at is not null
  union all
  select r.rn, r.amount, 'online', 'in', pp.display_name, r.settled_at
    from payment_requests r join profiles pp on pp.id = r.payer_id
   where r.merchant_id = p_user and r.settled_at is not null
  order by at desc nulls last
  limit p_limit;
$$;

-- Read-path indexes.
create index if not exists ledger_entries_account_idx on ledger_entries (account_id, created_at desc);
create index if not exists vouchers_payer_idx on vouchers (payer_id, created_at desc);
create index if not exists vouchers_merchant_idx on vouchers (merchant_id, created_at desc);
create index if not exists relay_events_recent_idx on relay_events (created_at desc);
create index if not exists proof_events_user_idx on proof_events (user_id, created_at desc);
create index if not exists pockets_user_active_idx on pockets (user_id) where status = 'active';
