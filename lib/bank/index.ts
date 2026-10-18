import type { BlazeBank } from "./adapter";
import { mockBank } from "./mock";
import { supabaseBank } from "./supabase";

// Active bank backend, picked by env. Routes always import getBank() — never a concrete class —
// so the mock (dev/demo without a database) and Supabase (deployed) stay drop-in equivalent.
// This module is server-side only: lib/bank/supabase.ts pulls in the service-role client.

export type { ActivityItem, BlazeBank, DemoUser, DeviceInfo, EcobankAdapter, MeResult, RelayEvent, SettleState } from "./adapter";

/** MockBank with an async skin: same Maps, same semantics, matching the BlazeBank surface. */
const mockBackend: BlazeBank = {
  getAccount: (u) => mockBank.getAccount(u),
  placePocketLien: (a) => mockBank.placePocketLien(a),
  releasePocket: (certId) => mockBank.releasePocket(certId),
  settleVoucher: (a) => mockBank.settleVoucher(a),
  registerDevice: async (userId, publicKey) => mockBank.registerDevice(userId, publicKey),
  getUser: async (userId) => mockBank.users.get(userId) ?? null,
  getDevice: async (deviceId) => mockBank.devices.get(deviceId) ?? null,
  getPocket: async (certId) => {
    const p = mockBank.pockets.get(certId);
    return p ? { userId: p.userId } : null;
  },
  listDemoUsers: async () => [...mockBank.users.values()],
  payOnline: async (payerId, merchantId, amount, nonce) => mockBank.payOnline(payerId, merchantId, amount, nonce),
  requestStatus: async (rn) => mockBank.requestStatus(rn),
  me: async (userId) => mockBank.me(userId),
  getEvents: async (limit) => mockBank.events.slice(0, limit),
  log: async (outcome, amount, detail) => {
    mockBank.log(outcome, amount, detail);
  },
};

export function getBank(): BlazeBank {
  return process.env.BANK_BACKEND === "supabase" ? supabaseBank : mockBackend;
}
