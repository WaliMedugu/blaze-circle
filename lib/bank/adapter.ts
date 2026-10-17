// The only seam between Blaze-Grid and a core bank. MockBank (Supabase ledger, Day 2) implements it
// for the demo; an Ecobank sandbox implementation can replace it without touching the relay.

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
