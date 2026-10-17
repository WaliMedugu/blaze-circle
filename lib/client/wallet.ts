"use client";

import { kvGet, kvSet, outboxList, outboxPut } from "@/lib/offline/db";
import { b64url, unpackCert } from "@/lib/relay/encoding";
import { exportRawPublic, generateDeviceKey, importRawPublic } from "@/lib/relay/keys";
import type { PocketState } from "@/lib/relay/types";
import type { DemoUser } from "@/lib/bank/mock";
import { api, ApiError } from "./api";

// Phone-side wallet: identity, device key, pocket, bank key, sync. All reads work offline.

export type MeResponse = {
  user: DemoUser;
  account: { balance: number; lien: number; available: number };
  activity: { key: string; amount: number; mode: "online" | "offline"; direction: "in" | "out"; counterparty: string; at: number }[];
};

// ── identity (per tab, so one laptop can be student in one tab and vendor in another) ──
export function getSession(): DemoUser | null {
  try {
    const raw = sessionStorage.getItem("blaze:user") ?? localStorage.getItem("blaze:user");
    return raw ? (JSON.parse(raw) as DemoUser) : null;
  } catch {
    return null;
  }
}
export function setSession(u: DemoUser | null) {
  try {
    for (const s of [sessionStorage, localStorage]) {
      if (u) s.setItem("blaze:user", JSON.stringify(u));
      else s.removeItem("blaze:user");
    }
  } catch {}
}

// ── device key: generated once, non-extractable, never leaves IndexedDB ──
type DeviceRecord = { keys: CryptoKeyPair; pub: string; id?: string };

export async function getDevice(uid: string, register = true): Promise<DeviceRecord> {
  let d = await kvGet<DeviceRecord>(`device:${uid}`);
  if (!d) {
    const keys = await generateDeviceKey();
    d = { keys, pub: b64url.encode(await exportRawPublic(keys.publicKey)) };
    await kvSet(`device:${uid}`, d);
  }
  if (!d.id && register) {
    try {
      d.id = (await api<{ deviceId: string }>("/api/devices", { userId: uid, publicKey: d.pub })).deviceId;
      await kvSet(`device:${uid}`, d);
    } catch {}
  }
  return d;
}

// ── bank public key: refreshed whenever online, cached for offline verification ──
export async function getBankKey(): Promise<CryptoKey | null> {
  let raw = await kvGet<string>("bankKey");
  try {
    const fresh = (await api<{ publicKey: string }>("/api/bank-key")).publicKey;
    if (fresh !== raw) await kvSet("bankKey", (raw = fresh));
  } catch {}
  return raw ? importRawPublic(b64url.decode(raw)) : null;
}

// ── pocket ──
export const getPocket = (uid: string) => kvGet<PocketState>(`pocket:${uid}`);
export const savePocket = (uid: string, s: PocketState) => kvSet(`pocket:${uid}`, s);

export async function topUpPocket(uid: string, amount: number): Promise<PocketState> {
  await sync(uid); // tell the bank about offline spend first, so renewal keeps the right lien
  const request = async () => {
    const device = await getDevice(uid);
    if (!device.id) throw new ApiError("offline");
    return api<{ cert: string }>("/api/pocket", { userId: uid, deviceId: device.id, amount });
  };
  let res: { cert: string };
  try {
    res = await request();
  } catch (e) {
    if ((e as Error).message !== "unknown_device") throw e;
    // dev server restarted and forgot this device: register again and retry once
    const d = await getDevice(uid, false);
    await kvSet(`device:${uid}`, { ...d, id: undefined });
    res = await request();
  }
  const { cert, bankSig } = unpackCert(res.cert);
  const state: PocketState = { cert, bankSig, ctr: 0, spent: 0 };
  await savePocket(uid, state);
  return state;
}

// ── me (balances + activity), cached for offline display ──
export async function loadMe(uid: string): Promise<{ me: MeResponse | null; fresh: boolean }> {
  try {
    const me = await api<MeResponse>(`/api/me?userId=${encodeURIComponent(uid)}`);
    await kvSet(`me:${uid}`, me);
    return { me, fresh: true };
  } catch {
    return { me: (await kvGet<MeResponse>(`me:${uid}`)) ?? null, fresh: false };
  }
}

// ── merchant replay protection ──
export const getSeen = async (uid: string) => new Set((await kvGet<string[]>(`seen:${uid}`)) ?? []);
export const addSeen = async (uid: string, key: string) => kvSet(`seen:${uid}`, [...(await getSeen(uid)), key]);

// ── sync: push pending vouchers; whoever gets signal first reports, the merchant's upload settles ──
export async function sync(uid: string): Promise<number> {
  let settled = 0;
  for (const item of await outboxList(uid)) {
    if (item.state !== "PENDING_SETTLEMENT") continue;
    let r: { state: string; reason?: string };
    try {
      r = await api("/api/vouchers", { qr: item.qr, submittedBy: item.role });
    } catch {
      break; // offline again — try next time
    }
    if (r.state === "SETTLED_CONFIRMED") {
      settled++;
      await outboxPut({ ...item, state: "SETTLED_CONFIRMED" });
    } else if (r.state === "REJECTED") {
      await outboxPut({ ...item, state: "REJECTED", reason: r.reason });
    }
  }
  return settled;
}
