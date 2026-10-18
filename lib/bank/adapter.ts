// The only seam between Blaze-Grid and a core bank. MockBank (lib/bank/mock.ts) implements the
// money-movement half for local dev; SupabaseBank (lib/bank/supabase.ts) implements the whole
// surface for the deployed demo. An Ecobank sandbox implementation can replace either without
// touching the relay. Pick the active one with getBank() in lib/bank/index.ts.

export interface EcobankAdapter {
  getAccount(userId: string): Promise<{ acctNo: string; balance: number; lien: number }>;
  /** Lock funds for a Blaze Pocket. Throws "insufficient_funds". */
  placePocketLien(args: { userId: string; deviceId: string; certId: string; limit: number; expiresAt: Date }): Promise<void>;
  releasePocket(certId: string): Promise<void>;
  /** Atomic, idempotent. Called only after lib/relay validateUpload() passed. */
  settleVoucher(args: {
    certId: string;
    ctr: number;
    merchantId: string;
    amount: number;
    nonce: string;
    payload: string;
    submittedBy: "merchant" | "payer" | "online";
  }): Promise<"SETTLED_CONFIRMED" | "PENDING" | "REJECTED">;
}

export interface DemoUser {
  id: string;
  tag: string;
  name: string;
  isMerchant: boolean;
}

export type SettleState = "SETTLED_CONFIRMED" | "PENDING" | "REJECTED";

/** Live Risk Console feed row. `at` is unix ms; `detail` is a display string. */
export interface RelayEvent {
  id: number;
  at: number;
  outcome: string; // SETTLED_CONFIRMED | PENDING | a RejectReason | pocket_issued ...
  amount?: number;
  detail?: string;
}

export interface DeviceInfo {
  userId: string;
  publicKey: string; // base64url raw P-256
  revoked: boolean;
}

/** One row of the /api/me "Recent" list (MeResponse.activity in lib/client/wallet.ts). */
export interface ActivityItem {
  key: string;
  amount: number;
  mode: "online" | "offline";
  direction: "in" | "out";
  counterparty: string;
  at: number;
}

export interface MeResult {
  user: DemoUser;
  account: { balance: number; lien: number; available: number };
  activity: ActivityItem[];
}

/** Everything the API routes need. All methods async so routes never care which backend is live. */
export interface BlazeBank extends EcobankAdapter {
  registerDevice(userId: string, publicKey: string): Promise<string>;
  getUser(userId: string): Promise<DemoUser | null>;
  getDevice(deviceId: string): Promise<DeviceInfo | null>;
  /** Ownership lookup used by the voucher route; null for an unknown cert. */
  getPocket(certId: string): Promise<{ userId: string } | null>;
  listDemoUsers(): Promise<DemoUser[]>;
  payOnline(payerId: string, merchantId: string, amount: number, nonce: string): Promise<SettleState | "insufficient_funds" | "unknown_user" | "malformed">;
  requestStatus(nonce: string): Promise<{ paid: boolean; payerTag?: string }>;
  me(userId: string): Promise<MeResult | null>;
  getEvents(limit: number): Promise<RelayEvent[]>;
  log(outcome: string, amount?: number, detail?: string): Promise<void>;
}
