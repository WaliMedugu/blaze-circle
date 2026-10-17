"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { PinPad } from "@/components/pin-pad";
import { QrCode } from "@/components/qr-code";
import { Scanner } from "@/components/scanner";
import { AppHeader, Shell, useSession } from "@/components/session";
import { api } from "@/lib/client/api";
import { getDevice, getPocket, savePocket } from "@/lib/client/wallet";
import { naira, nowS, reasonText } from "@/lib/format";
import { useConnectivity } from "@/lib/offline/connectivity";
import { outboxPut } from "@/lib/offline/db";
import { b64url, base45Decode, packRequest, unpackRequest } from "@/lib/relay/encoding";
import { sign } from "@/lib/relay/keys";
import { payOffline } from "@/lib/relay/protocol";
import { REQUEST_WINDOW_S } from "@/lib/relay/rules";
import type { ChargeRequest } from "@/lib/relay/types";

const DEMO_PIN = "1234";

type Step =
  | { s: "scan" }
  | { s: "confirm"; req: ChargeRequest }
  | { s: "voucher"; req: ChargeRequest; qr: string; at: number }
  | { s: "done"; req: ChargeRequest }
  | { s: "error"; text: string };

export default function PayPage() {
  const [user] = useSession();
  const conn = useConnectivity();
  const [step, setStep] = useState<Step>({ s: "scan" });
  const [pinError, setPinError] = useState<string>();
  const [handoff, setHandoff] = useState(false);

  if (!user) return null;

  const onScan = (text: string) => {
    try {
      const req = unpackRequest(text);
      if (!req.mid || !Number.isInteger(req.amt) || req.amt <= 0) throw new Error();
      setStep({ s: "confirm", req });
    } catch {
      setStep({ s: "error", text: "That isn't a Blaze payment request. Scan the vendor's code." });
    }
  };

  const payOff = async (req: ChargeRequest) => {
    const pocket = await getPocket(user.id);
    if (!pocket) return setStep({ s: "error", text: "No Blaze Pocket on this phone. Top up while you have signal." });
    const device = await getDevice(user.id, false);
    let r;
    try {
      r = await payOffline(pocket, req, device.keys.privateKey, nowS());
    } catch (e) {
      return setStep({ s: "error", text: `Offline rules not ready: ${(e as Error).message}` });
    }
    if (!r.ok) return setStep({ s: "error", text: reasonText(r.reason) });
    await savePocket(user.id, r.next);
    await outboxPut({
      key: `${r.voucher.cid}:${r.voucher.ctr}:${r.voucher.rn}`, owner: user.id, role: "payer", qr: r.qr,
      amount: req.amt, counterparty: req.mname, state: "PENDING_SETTLEMENT", at: Date.now(),
    });
    navigator.vibrate?.(40);
    setStep({ s: "voucher", req, qr: r.qr, at: nowS() });
  };

  const onPin = async (pin: string, req: ChargeRequest) => {
    if (pin !== DEMO_PIN) return setPinError("Wrong PIN");
    setPinError(undefined);
    if (conn === "offline") return payOff(req);
    try {
      const device = await getDevice(user.id);
      if (!device.id) throw new Error("offline");
      const packed = packRequest(req);
      const sig = await sign(device.keys.privateKey, base45Decode(packed));
      await api("/api/pay/online", { deviceId: device.id, request: packed, sig: b64url.encode(sig) });
      setStep({ s: "done", req });
    } catch (e) {
      if ((e as Error).message !== "offline") return setStep({ s: "error", text: reasonText((e as Error).message) });
      setHandoff(true); // network died mid-payment → fall through to proximity handoff
      payOff(req);
    }
  };

  return (
    <Shell>
      <AppHeader user={user} back="/" />

      {step.s === "scan" && <Scanner onResult={onScan} hint="Point at the vendor's Blaze code" />}

      {step.s === "confirm" && (
        <section className="flex flex-col gap-4">
          <div className="rounded-3xl bg-surface p-5 text-center">
            <p className="text-sm text-muted">Pay</p>
            <p className="text-lg font-semibold">{step.req.mname}</p>
            <p className="mt-2 text-5xl font-bold">{naira(step.req.amt)}</p>
            <p className={`mt-3 inline-block rounded-full px-3 py-1 text-xs ${conn === "offline" ? "bg-surface-2 text-accent" : "bg-ok/15 text-ok"}`}>
              {conn === "offline" ? "○ Offline · paid from Blaze Pocket" : "● Online · from your account"}
            </p>
          </div>
          <p className="text-center text-sm text-muted">Enter your Blaze PIN (demo: 1234)</p>
          <PinPad onComplete={(p) => onPin(p, step.req)} error={pinError} />
        </section>
      )}

      {step.s === "voucher" && <VoucherScreen step={step} handoff={handoff} />}

      {step.s === "done" && (
        <section className="flex flex-col items-center gap-3 rounded-3xl bg-surface p-8 text-center">
          <p className="text-6xl text-ok">✓</p>
          <p className="text-2xl font-bold">{naira(step.req.amt)} paid</p>
          <p className="text-muted">to {step.req.mname} · Settled</p>
          <Link href="/" className="mt-4 w-full rounded-2xl bg-accent py-4 font-bold text-background">
            Done
          </Link>
        </section>
      )}

      {step.s === "error" && (
        <section className="flex flex-col gap-4 rounded-3xl bg-surface p-6 text-center">
          <p className="text-4xl text-bad">✕</p>
          <p>{step.text}</p>
          <button onClick={() => setStep({ s: "scan" })} className="rounded-2xl bg-surface-2 py-3 font-semibold">
            Scan again
          </button>
        </section>
      )}
    </Shell>
  );
}

function VoucherScreen({ step, handoff }: { step: Extract<Step, { s: "voucher" }>; handoff: boolean }) {
  const [left, setLeft] = useState(REQUEST_WINDOW_S);
  useEffect(() => {
    const id = setInterval(() => setLeft(Math.max(0, REQUEST_WINDOW_S - (nowS() - step.at))), 500);
    return () => clearInterval(id);
  }, [step.at]);
  return (
    <section className="flex flex-col items-center gap-4 text-center">
      {handoff && <p className="rounded-full bg-warn/15 px-3 py-1 text-sm text-warn">◐ Connectivity lost. Proximity handoff active.</p>}
      <p className="text-lg font-semibold">Show this to {step.req.mname}</p>
      <QrCode value={step.qr} label={`Payment code for ${naira(step.req.amt)}`} />
      <p className="font-mono text-2xl">{naira(step.req.amt)}</p>
      <p className={left > 0 ? "text-muted" : "text-warn"}>
        {left > 0 ? `Code valid for ${left}s` : "Expired. If they didn't scan it, the money returns to your pocket."}
      </p>
      <Link href="/" className="w-full rounded-2xl bg-surface py-4 font-semibold">
        Vendor scanned it
      </Link>
    </section>
  );
}
