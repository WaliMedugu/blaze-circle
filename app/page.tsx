"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AppHeader, IdentityPicker, Shell, useSession } from "@/components/session";
import type { DemoUser } from "@/lib/bank/mock";
import { isForcedOffline, setForcedOffline } from "@/lib/client/api";
import { getBankKey, getDevice, getPocket, loadMe, sync, topUpPocket, type MeResponse } from "@/lib/client/wallet";
import { naira, nowS, reasonText } from "@/lib/format";
import { useConnectivity } from "@/lib/offline/connectivity";
import { outboxList, type OutboxItem } from "@/lib/offline/db";
import { MAX_PENDING, MAX_POCKET } from "@/lib/relay/rules";
import type { PocketState } from "@/lib/relay/types";

export default function Home() {
  const [user, setUser] = useSession();
  const router = useRouter();
  useEffect(() => {
    if (user?.isMerchant) router.replace("/merchant");
  }, [user, router]);

  if (user === undefined || user?.isMerchant) return null;
  if (!user) return <IdentityPicker onPick={setUser} />;
  return <StudentHome user={user} onSwitch={() => setUser(null)} />;
}

function StudentHome({ user, onSwitch }: { user: DemoUser; onSwitch: () => void }) {
  const conn = useConnectivity();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [fresh, setFresh] = useState(false);
  const [pocket, setPocket] = useState<PocketState>();
  const [outbox, setOutbox] = useState<OutboxItem[]>([]);
  const [topUp, setTopUp] = useState(false);
  const [msg, setMsg] = useState<string>();

  const refresh = useCallback(async () => {
    if (conn !== "offline") {
      await Promise.all([getDevice(user.id), getBankKey()]);
      await sync(user.id);
    }
    const r = await loadMe(user.id);
    setMe(r.me);
    setFresh(r.fresh);
    setPocket(await getPocket(user.id));
    setOutbox((await outboxList(user.id)).filter((o) => o.role === "payer"));
  }, [conn, user.id]);

  useEffect(() => {
    refresh(); // eslint-disable-line react-hooks/set-state-in-effect -- loads from IndexedDB + network
  }, [refresh]);

  const doTopUp = async (amount: number) => {
    setMsg(undefined);
    try {
      setPocket(await topUpPocket(user.id, amount));
      setTopUp(false);
      refresh();
    } catch (e) {
      setMsg(reasonText((e as Error).message));
    }
  };

  const pending = outbox.filter((o) => o.state === "PENDING_SETTLEMENT");
  const pocketLeft = pocket ? pocket.cert.lim - pocket.spent : 0;
  const pocketValid = pocket && nowS() < pocket.cert.exp && pocket.ctr < MAX_PENDING;
  const hoursLeft = pocket ? Math.max(0, Math.round((pocket.cert.exp - nowS()) / 3600)) : 0;

  return (
    <Shell>
      <AppHeader user={user} />

      <section className="rounded-3xl bg-gradient-to-br from-brand to-surface-2 p-5 shadow-lg">
        <p className="text-sm text-foreground/80">Ecobank account {fresh ? "" : "· last synced"}</p>
        <p className={`mt-1 text-4xl font-bold tracking-tight ${fresh ? "" : "opacity-60"}`}>{me ? naira(me.account.available) : "—"}</p>
        <div className="mt-5 rounded-2xl bg-background/40 p-4">
          <div className="flex items-baseline justify-between">
            <p className="text-sm font-medium">Blaze Pocket</p>
            <p className="font-mono text-sm">
              {naira(pocketLeft)} / {naira(pocket?.cert.lim ?? MAX_POCKET)}
            </p>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-background/60">
            <div className="h-full bg-accent" style={{ width: `${pocket ? (pocketLeft / pocket.cert.lim) * 100 : 0}%` }} />
          </div>
          <p className={`mt-2 text-xs ${pocketValid ? "text-accent" : "text-warn"}`}>
            {!pocket
              ? "◐ No pocket yet. Top up while online to pay offline."
              : pocketValid
                ? `✓ Offline-ready · ${MAX_PENDING - pocket.ctr} offline payments left · renews in ${hoursLeft}h`
                : "◐ Pocket used up or expired. Top up when you have signal."}
          </p>
        </div>
      </section>

      <Link href="/pay" className="rounded-2xl bg-accent py-5 text-center text-xl font-bold text-background active:scale-[0.98]">
        Scan to Pay
      </Link>
      <button
        onClick={() => setTopUp((v) => !v)}
        disabled={conn === "offline"}
        className="rounded-2xl bg-surface py-4 font-semibold disabled:opacity-50"
      >
        {conn === "offline" ? "Top up needs signal" : "Top up Pocket"}
      </button>

      {topUp && (
        <section className="rounded-2xl bg-surface p-4">
          <p className="font-medium">Lock money for offline payments</p>
          <p className="mt-1 text-sm text-muted">It stays yours. Unused money returns to your account when the pocket renews.</p>
          <div className="mt-3 grid grid-cols-3 gap-2">
            {[1000, 2000, 5000].map((a) => (
              <button key={a} onClick={() => doTopUp(a)} className="rounded-xl bg-surface-2 py-3 font-semibold active:bg-brand">
                {naira(a)}
              </button>
            ))}
          </div>
        </section>
      )}
      {msg && <p className="text-sm text-bad">✕ {msg}</p>}

      {pending.length > 0 && (
        <section className="rounded-2xl bg-surface p-4">
          <div className="flex items-center justify-between">
            <p className="font-medium">Offline payments waiting</p>
            <span className="rounded-full bg-warn/15 px-2 py-0.5 text-sm text-warn">◐ {pending.length}</span>
          </div>
          <p className="mt-1 text-sm text-muted">They settle automatically when you or the vendor get signal.</p>
          <ul className="mt-2 divide-y divide-surface-2">
            {pending.map((o) => (
              <li key={o.key} className="flex justify-between py-2 text-sm">
                <span>{o.counterparty}</span>
                <span className="font-mono">−{naira(o.amount)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <p className="mb-2 text-sm font-medium text-muted">Recent</p>
        <ul className="divide-y divide-surface rounded-2xl bg-surface/60 px-4">
          {(me?.activity ?? []).length === 0 && <li className="py-3 text-sm text-muted">No payments yet.</li>}
          {me?.activity.map((a) => (
            <li key={a.key} className="flex items-center justify-between py-3 text-sm">
              <span>
                <span className="block">{a.counterparty}</span>
                <span className="text-xs text-ok">● Settled · {a.mode}</span>
              </span>
              <span className="font-mono">
                {a.direction === "out" ? "−" : "+"}
                {naira(a.amount)}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <footer className="mt-auto flex items-center justify-between text-xs text-muted">
        <button onClick={onSwitch} className="underline">
          Switch demo user
        </button>
        <label className="flex items-center gap-2">
          <input type="checkbox" defaultChecked={isForcedOffline()} onChange={(e) => setForcedOffline(e.target.checked)} />
          Simulate no data
        </label>
      </footer>
    </Shell>
  );
}
