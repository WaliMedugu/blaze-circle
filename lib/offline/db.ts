"use client";

import { openDB, type DBSchema, type IDBPDatabase } from "idb";

// Everything a phone needs with zero data: device keys, pocket cert, bank public key,
// merchant replay set, last-known balances, and the voucher outbox. Keys are per user id so
// two demo identities in two tabs of one browser don't collide.

export interface OutboxItem {
  key: string; // `${cid}:${ctr}:${rn}`
  owner: string; // user id
  role: "payer" | "merchant";
  qr: string;
  amount: number;
  counterparty: string;
  state: "PENDING_SETTLEMENT" | "SETTLED_CONFIRMED" | "REJECTED";
  reason?: string;
  at: number;
}

interface BlazeDB extends DBSchema {
  kv: { key: string; value: unknown };
  outbox: { key: string; value: OutboxItem; indexes: { owner: string } };
}

let dbp: Promise<IDBPDatabase<BlazeDB>> | undefined;
const db = () =>
  (dbp ??= openDB<BlazeDB>("blaze", 1, {
    upgrade(d) {
      d.createObjectStore("kv");
      d.createObjectStore("outbox", { keyPath: "key" }).createIndex("owner", "owner");
    },
  }));

export const kvGet = async <T>(k: string) => (await (await db()).get("kv", k)) as T | undefined;
export const kvSet = async (k: string, v: unknown) => void (await (await db()).put("kv", v, k));
export const kvDel = async (k: string) => (await db()).delete("kv", k);

export const outboxPut = async (item: OutboxItem) => void (await (await db()).put("outbox", item));
export const outboxList = async (owner: string) =>
  ((await (await db()).getAllFromIndex("outbox", "owner", owner)) as OutboxItem[]).sort((a, b) => b.at - a.at);
