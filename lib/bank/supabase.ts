import "server-only";
import type { ActivityItem, BlazeBank, DemoUser, DeviceInfo, MeResult, RelayEvent, SettleState } from "./adapter";
import { supabaseAdmin } from "@/lib/supabase/server";

// Supabase-backed BlazeBank. Money movement happens only inside the plpgsql functions from
// migrations 0001/0002 (issue_pocket / release_pocket / settle_voucher / pay_online), each of
// which is atomic + idempotent and writes ledger_entries in the same transaction. Signature
// checks stay in the routes (lib/relay) — Postgres has no ECDSA verify.

const db = () => supabaseAdmin();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The client is created without Database generics (schema comes from migrations), so query
// results are shapeless. We type each call site explicitly instead of trusting inference.
type Resultish = { data: unknown; error: { message: string } | null };

async function run<T>(q: PromiseLike<Resultish>): Promise<T> {
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data as T;
}

/** RPC call returning a scalar/text (or row array for my_activity). */
async function rpc<T = void>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db().rpc(fn, args);
  if (error) throw new Error(error.message); // e.g. "insufficient_funds", "unknown_device"
  return data as T;
}

/** relay_events.detail is jsonb here but a display string on the wire (mock parity). */
const detailToString = (d: unknown): string | undefined => {
  if (d == null) return undefined;
  if (typeof d === "string") return d;
  if (typeof d === "object") return Object.values(d as Record<string, unknown>).join(" · ");
  return String(d);
};

type ProfileRow = { id: string; tag: string; display_name: string; is_merchant: boolean };

const toUser = (r: ProfileRow): DemoUser => ({
  id: r.id,
  tag: r.tag,
  name: r.display_name,
  isMerchant: r.is_merchant,
});

export const supabaseBank: BlazeBank = {
  async getAccount(userId) {
    const a = await run<{ acct_no: string; balance: number; lien_total: number } | null>(
      db().from("bank_accounts").select("acct_no, balance, lien_total").eq("user_id", userId).maybeSingle(),
    );
    if (!a) throw new Error("unknown_user");
    return { acctNo: a.acct_no, balance: a.balance, lien: a.lien_total };
  },

  async placePocketLien({ userId, deviceId, certId, limit, expiresAt }) {
    await rpc("issue_pocket", {
      p_user: userId,
      p_device: deviceId,
      p_cert: certId,
      p_limit: limit,
      p_expires: expiresAt.toISOString(),
    });
  },

  async releasePocket(certId) {
    await rpc("release_pocket", { p_cert: certId });
  },

  async settleVoucher(a) {
    // validateUpload() already passed in the route; this is the atomic, idempotent settle.
    return await rpc<SettleState>("settle_voucher", {
      p_cert: a.certId,
      p_ctr: a.ctr,
      p_merchant: a.merchantId,
      p_amount: a.amount,
      p_nonce: a.nonce,
      p_payload: a.payload,
      p_submitted_by: a.submittedBy,
    });
  },

  async registerDevice(userId, publicKey) {
    if (!UUID_RE.test(userId)) throw new Error("unknown_user");
    const user = await run<{ id: string } | null>(db().from("profiles").select("id").eq("id", userId).maybeSingle());
    if (!user) throw new Error("unknown_user");
    const row = await run<{ id: string }>(db().from("devices").insert({ user_id: userId, public_key: publicKey }).select("id").single());
    return row.id;
  },

  async getUser(userId) {
    if (!UUID_RE.test(userId)) return null;
    const r = await run<ProfileRow | null>(db().from("profiles").select("id, tag, display_name, is_merchant").eq("id", userId).maybeSingle());
    return r ? toUser(r) : null;
  },

  async getDevice(deviceId) {
    if (!UUID_RE.test(deviceId)) return null;
    const r = await run<{ user_id: string; public_key: string; revoked: boolean } | null>(
      db().from("devices").select("user_id, public_key, revoked").eq("id", deviceId).maybeSingle(),
    );
    return r ? { userId: r.user_id, publicKey: r.public_key, revoked: r.revoked } satisfies DeviceInfo : null;
  },

  async getPocket(certId) {
    if (!UUID_RE.test(certId)) return null;
    const r = await run<{ user_id: string } | null>(db().from("pockets").select("user_id").eq("cert_id", certId).maybeSingle());
    return r ? { userId: r.user_id } : null;
  },

  async listDemoUsers() {
    const rows = (await run<ProfileRow[] | null>(db().from("profiles").select("id, tag, display_name, is_merchant").order("created_at"))) ?? [];
    return rows.map(toUser);
  },

  async payOnline(payerId, merchantId, amount, nonce) {
    // Returns the same states MockBank.payOnline can produce.
    return await rpc("pay_online", { p_payer: payerId, p_merchant: merchantId, p_amount: amount, p_rn: nonce });
  },

  async requestStatus(rn) {
    const r = await run<{ payer_id: string | null; profiles: { tag: string } | null } | null>(
      db().from("payment_requests").select("payer_id, profiles:payer_id ( tag )").eq("rn", rn).maybeSingle(),
    );
    return r?.payer_id && r.profiles ? { paid: true, payerTag: r.profiles.tag } : { paid: false };
  },

  async me(userId) {
    // PostgREST rejects non-uuid text in eq(), so screen ids here (mock ids like "u_wali" are
    // not uuids and must not 500 this route).
    if (!UUID_RE.test(userId)) return null;
    const user = await this.getUser(userId); // null → unknown user, like mockBank.me
    if (!user) return null;
    const [acct, activity] = await Promise.all([
      run<{ balance: number; lien_total: number }>(db().from("bank_accounts").select("balance, lien_total").eq("user_id", userId).single()),
      loadActivity(userId),
    ]);
    return {
      user,
      account: { balance: acct.balance, lien: acct.lien_total, available: acct.balance - acct.lien_total },
      activity,
    } satisfies MeResult;
  },

  async getEvents(limit) {
    const rows =
      (await run<
        { id: number; outcome: string; amount: number | null; detail: unknown; created_at: string }[] | null
      >(db().from("relay_events").select("id, outcome, amount, detail, created_at").order("created_at", { ascending: false }).limit(limit))) ?? [];
    return rows.map((r): RelayEvent => ({
      id: r.id,
      at: Date.parse(r.created_at),
      outcome: r.outcome,
      amount: r.amount ?? undefined,
      detail: detailToString(r.detail),
    }));
  },

  async log(outcome, amount, detail) {
    // Risk Console feed only — a logging failure must never fail the payment that triggered it.
    try {
      await run(db().from("relay_events").insert({ outcome, amount: amount ?? null, detail: detail ? { note: detail } : null }));
    } catch {
      /* swallow */
    }
  },
};

// my_activity() row shape (migration 0002).
interface ActivityRow {
  ref: string;
  amount: number;
  mode: "online" | "offline";
  direction: "in" | "out";
  counterparty: string | null;
  at: string | null;
}

async function loadActivity(userId: string): Promise<ActivityItem[]> {
  const rows = (await rpc<ActivityRow[]>("my_activity", { p_user: userId, p_limit: 30 })) ?? [];
  return rows.map((r) => ({
    key: r.ref,
    amount: r.amount,
    mode: r.mode,
    direction: r.direction,
    counterparty: r.counterparty ?? "?",
    at: r.at ? Date.parse(r.at) : 0,
  }));
}
