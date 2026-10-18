import type { DemoUser, EcobankAdapter, RelayEvent, SettleState } from "./adapter";

// In-memory stand-in for Ecobank + Supabase. Mirrors supabase/migrations/0001_init.sql so the
// swap is mechanical. State lives on globalThis (survives dev hot-reload, NOT a server restart,
// and NOT serverless instances on Vercel — use Supabase for the deployed demo).

// Re-exported so existing imports (lib/client/wallet.ts) keep working; the types now live on the
// shared bank seam in lib/bank/adapter.ts.
export type { DemoUser, RelayEvent, SettleState } from "./adapter";

interface Account {
  balance: number;
  lien: number;
}

interface Pocket {
  certId: string;
  userId: string;
  deviceId: string;
  limit: number;
  held: number; // lien still locked for this pocket
  settled: number; // merchant-settled spend
  reported: number; // payer-reported spend (may arrive before the merchant syncs)
  expiresAt: number; // unix s
  status: "active" | "superseded" | "released" | "revoked";
}

interface Payment {
  key: string;
  payerId: string;
  merchantId: string;
  amount: number;
  mode: "online" | "offline";
  state: "SETTLED_CONFIRMED";
  fraud?: "double_spend" | "overspend";
  at: number;
}

const SEED: (DemoUser & { balance: number })[] = [
  { id: "u_wali", tag: "$wali", name: "Wali", isMerchant: false, balance: 18_250 },
  { id: "u_joan", tag: "$joan", name: "Joan", isMerchant: false, balance: 12_000 },
  { id: "u_helen", tag: "$helen", name: "Helen", isMerchant: false, balance: 9_000 },
  { id: "u_timothy", tag: "$timothy", name: "Timothy", isMerchant: false, balance: 7_500 },
  { id: "m_mama_tee", tag: "$mamatee", name: "Mama Tee's Kitchen", isMerchant: true, balance: 0 },
  { id: "m_prints", tag: "$campusprints", name: "Campus Prints", isMerchant: true, balance: 0 },
];

export class MockBank implements EcobankAdapter {
  users = new Map<string, DemoUser>();
  accounts = new Map<string, Account>();
  devices = new Map<string, { userId: string; publicKey: string; revoked: boolean }>();
  pockets = new Map<string, Pocket>();
  payments: Payment[] = [];
  private seenVouchers = new Map<string, string>(); // `${cid}:${ctr}` → nonce (settled)
  private payerReports = new Set<string>(); // `${cid}:${ctr}:${nonce}`
  private paidRequests = new Map<string, string>(); // nonce → payer tag
  events: RelayEvent[] = [];
  private eventId = 0;

  constructor() {
    for (const { balance, ...u } of SEED) {
      this.users.set(u.id, u);
      this.accounts.set(u.id, { balance, lien: 0 });
    }
  }

  log(outcome: string, amount?: number, detail?: string) {
    this.events.unshift({ id: ++this.eventId, at: Date.now(), outcome, amount, detail });
    this.events.length = Math.min(this.events.length, 200);
  }

  registerDevice(userId: string, publicKey: string) {
    if (!this.users.has(userId)) throw new Error("unknown_user");
    const id = crypto.randomUUID();
    this.devices.set(id, { userId, publicKey, revoked: false });
    return id;
  }

  async getAccount(userId: string) {
    const a = this.mustAccount(userId);
    return { acctNo: `20${userId.length}${userId.charCodeAt(2)}0042`, balance: a.balance, lien: a.lien };
  }

  async placePocketLien({ userId, deviceId, certId, limit, expiresAt }: Parameters<EcobankAdapter["placePocketLien"]>[0]) {
    const acct = this.mustAccount(userId);
    const device = this.devices.get(deviceId);
    if (!device || device.userId !== userId) throw new Error("unknown_device");
    if (device.revoked) throw new Error("device_revoked");

    // Renewing: keep lien only for spend the payer already told us about but merchants haven't settled.
    for (const p of this.pockets.values()) {
      if (p.deviceId === deviceId && p.status === "active") {
        const outstanding = Math.max(0, Math.min(p.limit, p.reported) - p.settled);
        acct.lien -= p.held - outstanding;
        p.held = outstanding;
        p.status = "superseded";
      }
    }
    if (acct.balance - acct.lien < limit) throw new Error("insufficient_funds");
    acct.lien += limit;
    this.pockets.set(certId, {
      certId, userId, deviceId, limit, held: limit, settled: 0, reported: 0,
      expiresAt: Math.floor(expiresAt.getTime() / 1000), status: "active",
    });
    this.log("pocket_issued", limit, this.users.get(userId)?.tag);
  }

  async releasePocket(certId: string) {
    const p = this.pockets.get(certId);
    if (!p || p.status === "released" || p.status === "revoked") return;
    this.mustAccount(p.userId).lien -= p.held;
    p.held = 0;
    p.status = "released";
  }

  /** Called only after lib/relay validateUpload() passed. Policy: plan §3.4. */
  async settleVoucher(a: Parameters<EcobankAdapter["settleVoucher"]>[0]): Promise<SettleState> {
    const p = this.pockets.get(a.certId);
    if (!p) {
      this.log("unknown_cert", a.amount);
      return "REJECTED";
    }
    const vkey = `${a.certId}:${a.ctr}`;
    const prior = this.seenVouchers.get(vkey);
    if (prior === a.nonce) return "SETTLED_CONFIRMED"; // idempotent re-upload

    if (a.submittedBy === "payer") {
      const rkey = `${vkey}:${a.nonce}`;
      if (!this.payerReports.has(rkey)) {
        this.payerReports.add(rkey);
        p.reported += a.amount;
        this.log("payer_reported", a.amount, this.users.get(p.userId)?.tag);
      }
      return "PENDING"; // only the merchant's upload moves money
    }

    let fraud: Payment["fraud"];
    if (prior !== undefined) fraud = "double_spend"; // same counter signed for two sales
    else if (p.settled + a.amount > p.limit) fraud = "overspend";

    const fromPocket = Math.min(a.amount, p.held);
    const payer = this.mustAccount(p.userId);
    payer.balance -= a.amount; // the merchant is always paid; any excess is recovered here
    payer.lien -= fromPocket;
    p.held -= fromPocket;
    p.settled += a.amount;
    this.mustAccount(a.merchantId).balance += a.amount;

    if (fraud) {
      payer.lien -= p.held;
      p.held = 0;
      p.status = "revoked";
      const d = this.devices.get(p.deviceId);
      if (d) d.revoked = true;
    }
    if (prior === undefined) this.seenVouchers.set(vkey, a.nonce);
    this.paidRequests.set(a.nonce, this.users.get(p.userId)?.tag ?? "");
    this.payments.unshift({
      key: `${vkey}:${a.nonce}`, payerId: p.userId, merchantId: a.merchantId, amount: a.amount,
      mode: "offline", state: "SETTLED_CONFIRMED", fraud, at: Date.now(),
    });
    this.log("SETTLED_CONFIRMED", a.amount, fraud ? `${fraud} · recovered from payer` : `offline · ${this.users.get(p.userId)?.tag}`);
    return "SETTLED_CONFIRMED";
  }

  payOnline(payerId: string, merchantId: string, amount: number, nonce: string): SettleState | "insufficient_funds" {
    if (this.paidRequests.has(nonce)) return "REJECTED";
    const payer = this.mustAccount(payerId);
    if (payer.balance - payer.lien < amount) return "insufficient_funds";
    payer.balance -= amount;
    this.mustAccount(merchantId).balance += amount;
    this.paidRequests.set(nonce, this.users.get(payerId)?.tag ?? "");
    this.payments.unshift({ key: `online:${nonce}`, payerId, merchantId, amount, mode: "online", state: "SETTLED_CONFIRMED", at: Date.now() });
    this.log("SETTLED_CONFIRMED", amount, `online · ${this.users.get(payerId)?.tag}`);
    return "SETTLED_CONFIRMED";
  }

  requestStatus(nonce: string) {
    const tag = this.paidRequests.get(nonce);
    return tag === undefined ? { paid: false } : { paid: true, payerTag: tag };
  }

  me(userId: string) {
    const user = this.users.get(userId);
    if (!user) return null;
    const acct = this.mustAccount(userId);
    const activity = this.payments
      .filter((p) => p.payerId === userId || p.merchantId === userId)
      .slice(0, 30)
      .map((p) => {
        const out = p.payerId === userId;
        return {
          key: p.key, amount: p.amount, mode: p.mode, state: p.state, at: p.at,
          direction: out ? ("out" as const) : ("in" as const),
          counterparty: this.users.get(out ? p.merchantId : p.payerId)?.name ?? "?",
        };
      });
    return { user, account: { balance: acct.balance, lien: acct.lien, available: acct.balance - acct.lien }, activity };
  }

  private mustAccount(userId: string) {
    const a = this.accounts.get(userId);
    if (!a) throw new Error("unknown_user");
    return a;
  }
}

const g = globalThis as { __blazeBank?: MockBank };
export const mockBank = (g.__blazeBank ??= new MockBank());
