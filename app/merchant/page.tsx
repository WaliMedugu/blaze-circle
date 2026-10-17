"use client";

import { useCallback, useEffect, useState } from "react";
import { QrCode } from "@/components/qr-code";
import { Scanner } from "@/components/scanner";
import { AppHeader, IdentityPicker, Shell, useSession } from "@/components/session";
import { api } from "@/lib/client/api";
import { addSeen, getBankKey, getSeen, loadMe, sync, type MeResponse } from "@/lib/client/wallet";
import { naira, nowS, reasonText } from "@/lib/format";
import { useConnectivity } from "@/lib/offline/connectivity";
import { outboxList, outboxPut, type OutboxItem } from "@/lib/offline/db";
import { packRequest, randomHex } from "@/lib/relay/encoding";
import { acceptVoucher } from "@/lib/relay/protocol";
import { REQUEST_WINDOW_S } from "@/lib/relay/rules";
import type { ChargeRequest } from "@/lib/relay/types";

type Phase =
  | { p: "keypad" }
  | { p: "request"; req: ChargeRequest }
  | { p: "scan"; req: ChargeRequest }
  | { p: "result"; ok: boolean; title: string; sub: string };

export default function MerchantPage() {
  const [user, setUser] = useSession();
  if (user === undefined) return null;
  if (!user || !user.isMerchant) return <IdentityPicker onPick={setUser} />;
  return <Merchant mid={user.id} name={user.name} user={user} onSwitch={() => setUser(null)} />;
}

function Merchant({ mid, name, user, onSwitch }: { mid: string; name: string; user: NonNullable<ReturnType<typeof useSession>[0]>; onSwitch: () => void }) {
  const conn = useConnectivity();
  const [amount, setAmount] = useState("");
  const [phase, setPhase] = useState<Phase>({ p: "keypad" });
  const [sales, setSales] = useState<OutboxItem[]>([]);
  const [me, setMe] = useState<MeResponse | null>(null);

  const refresh = useCallback(async () => {
    if (conn !== "offline") {
      await getBankKey();
      const n = await sync(mid);
      if (n > 0) setPhase((ph) => (ph.p === "result" && ph.ok ? { ...ph, title: "Settled ✓", sub: "Money is in your Ecobank account." } : ph));
    }
    setMe((await loadMe(mid)).me);
    setSales((await outboxList(mid)).filter((o) => o.role === "merchant"));
  }, [conn, mid]);

  useEffect(() => {
    refresh(); // eslint-disable-line react-hooks/set-state-in-effect -- loads from IndexedDB + network
  }, [refresh]);

  // While showing a request online, watch for an online payment so no second scan is needed.
  const rn = phase.p === "request" ? phase.req.rn : undefined;
  useEffect(() => {
    if (!rn || conn === "offline") return;
    const id = setInterval(async () => {
      try {
        const s = await api<{ paid: boolean; payerTag?: string }>(`/api/requests?rn=${rn}`);
        if (s.paid) {
          setPhase((ph) => (ph.p === "request" ? { p: "result", ok: true, title: `${naira(ph.req.amt)} received`, sub: `Settled ✓ · from ${s.payerTag} · online` } : ph));
          refresh();
        }
      } catch {}
    }, 1500);
    return () => clearInterval(id);
  }, [rn, conn, refresh]);

  const charge = () => {
    const amt = parseInt(amount, 10);
    if (!amt) return;
    setPhase({ p: "request", req: { mid, mname: name, amt, rn: randomHex(), t: nowS() } });
  };

  const onVoucher = async (qr: string, req: ChargeRequest) => {
    const bankPublic = await getBankKey();
    if (!bankPublic) return setPhase({ p: "result", ok: false, title: "Can't verify", sub: "Open the app once with signal to load Ecobank's key." });
    const r = await acceptVoucher(qr, { bankPublic, merchantId: mid, open: req, now: nowS(), seen: await getSeen(mid) });
    if (!r.ok) return setPhase({ p: "result", ok: false, title: "Not accepted", sub: reasonText(r.reason) });
    await addSeen(mid, `${r.voucher.cid}:${r.voucher.ctr}`);
    await outboxPut({
      key: `${r.voucher.cid}:${r.voucher.ctr}:${r.voucher.rn}`, owner: mid, role: "merchant", qr,
      amount: r.voucher.amt, counterparty: r.cert.tag, state: "PENDING_SETTLEMENT", at: Date.now(),
    });
    navigator.vibrate?.([60, 40, 60]);
    setPhase({ p: "result", ok: true, title: `${naira(r.voucher.amt)} received`, sub: `Guaranteed by Ecobank · from ${r.cert.tag} · settles when online` });
    setAmount("");
    refresh();
  };

  const pendingTotal = sales.filter((s) => s.state === "PENDING_SETTLEMENT").reduce((t, s) => t + s.amount, 0);

  return (
    <Shell>
      <AppHeader user={user} />

      {phase.p === "keypad" && (
        <section className="flex flex-col gap-3">
          <p className="rounded-3xl bg-surface py-6 text-center font-mono text-5xl font-bold">{naira(parseInt(amount || "0", 10))}</p>
          <div className="grid grid-cols-3 gap-2">
            {["1", "2", "3", "4", "5", "6", "7", "8", "9", "00", "0", "⌫"].map((k) => (
              <button
                key={k}
                onClick={() => setAmount((a) => (k === "⌫" ? a.slice(0, -1) : (a + k).replace(/^0+/, "").slice(0, 6)))}
                className="rounded-2xl bg-surface py-4 text-2xl font-semibold active:bg-surface-2"
              >
                {k}
              </button>
            ))}
          </div>
          <button onClick={charge} disabled={!parseInt(amount || "0", 10)} className="rounded-2xl bg-accent py-5 text-xl font-bold text-background disabled:opacity-40">
            Charge
          </button>
        </section>
      )}

      {phase.p === "request" && (
        <RequestScreen req={phase.req} online={conn !== "offline"} onScan={() => setPhase({ p: "scan", req: phase.req })} onCancel={() => setPhase({ p: "keypad" })} />
      )}

      {phase.p === "scan" && (
        <section className="flex flex-col gap-3">
          <Scanner onResult={(qr) => onVoucher(qr, phase.req)} hint="Scan the customer's payment code" />
          <button onClick={() => setPhase({ p: "request", req: phase.req })} className="rounded-2xl bg-surface py-3">
            Back to request
          </button>
        </section>
      )}

      {phase.p === "result" && (
        <section className={`flex flex-col items-center gap-2 rounded-3xl p-8 text-center ${phase.ok ? "bg-ok/15" : "bg-bad/15"}`} role="status">
          <p className={`text-6xl ${phase.ok ? "text-ok" : "text-bad"}`}>{phase.ok ? "✓" : "✕"}</p>
          <p className="text-3xl font-bold">{phase.title}</p>
          <p className="text-sm">{phase.sub}</p>
          <button onClick={() => setPhase({ p: "keypad" })} className="mt-4 w-full rounded-2xl bg-accent py-4 font-bold text-background">
            New sale
          </button>
        </section>
      )}

      <section className="rounded-2xl bg-surface p-4">
        <div className="flex justify-between text-sm">
          <span className="text-muted">Account</span>
          <span className="font-mono">{me ? naira(me.account.balance) : "—"}</span>
        </div>
        {pendingTotal > 0 && (
          <div className="mt-1 flex justify-between text-sm text-warn">
            <span>◐ Waiting to settle</span>
            <span className="font-mono">{naira(pendingTotal)}</span>
          </div>
        )}
        <ul className="mt-3 divide-y divide-surface-2 text-sm">
          {sales.map((s) => (
            <li key={s.key} className="flex justify-between py-2">
              <span>
                {s.counterparty}{" "}
                <span className={s.state === "SETTLED_CONFIRMED" ? "text-ok" : s.state === "REJECTED" ? "text-bad" : "text-warn"}>
                  {s.state === "SETTLED_CONFIRMED" ? "● Settled" : s.state === "REJECTED" ? `✕ ${s.reason}` : "◐ Pending"}
                </span>
              </span>
              <span className="font-mono">+{naira(s.amount)}</span>
            </li>
          ))}
          {me?.activity
            .filter((a) => a.mode === "online")
            .map((a) => (
              <li key={a.key} className="flex justify-between py-2">
                <span>
                  {a.counterparty} <span className="text-ok">● Settled · online</span>
                </span>
                <span className="font-mono">+{naira(a.amount)}</span>
              </li>
            ))}
        </ul>
      </section>

      <button onClick={onSwitch} className="mt-auto text-left text-xs text-muted underline">
        Switch demo user
      </button>
    </Shell>
  );
}

function RequestScreen({ req, online, onScan, onCancel }: { req: ChargeRequest; online: boolean; onScan: () => void; onCancel: () => void }) {
  const [left, setLeft] = useState(REQUEST_WINDOW_S);
  useEffect(() => {
    const id = setInterval(() => setLeft(Math.max(0, REQUEST_WINDOW_S - (nowS() - req.t))), 500);
    return () => clearInterval(id);
  }, [req.t]);
  return (
    <section className="flex flex-col items-center gap-3 text-center">
      <p className="text-lg font-semibold">Customer scans to pay {naira(req.amt)}</p>
      <QrCode value={packRequest(req)} label={`Payment request for ${naira(req.amt)}`} />
      <p className={left > 0 ? "text-muted" : "text-warn"}>{left > 0 ? `Valid for ${left}s` : "Expired. Start a new sale."}</p>
      {online && <p className="text-sm text-ok">● Waiting for payment…</p>}
      <button onClick={onScan} className="w-full rounded-2xl bg-accent py-4 font-bold text-background">
        Customer is offline → scan their code
      </button>
      <button onClick={onCancel} className="text-sm text-muted underline">
        Cancel
      </button>
    </section>
  );
}
