"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { DemoUser } from "@/lib/bank/mock";
import { api } from "@/lib/client/api";
import { getSession, setSession } from "@/lib/client/wallet";
import { ConnectivityPill } from "./connectivity-pill";

/** Reads the demo identity after mount (sessionStorage isn't available during SSR). */
export function useSession() {
  const [user, setUser] = useState<DemoUser | null | undefined>(undefined);
  useEffect(() => {
    setUser(getSession()); // eslint-disable-line react-hooks/set-state-in-effect -- browser-only read
  }, []);
  return [user, (u: DemoUser | null) => (setSession(u), setUser(u))] as const;
}

export function IdentityPicker({ onPick }: { onPick: (u: DemoUser) => void }) {
  const [users, setUsers] = useState<DemoUser[]>();
  const [err, setErr] = useState(false);
  useEffect(() => {
    api<{ users: DemoUser[] }>("/api/demo/users").then((r) => setUsers(r.users), () => setErr(true));
  }, []);
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 py-8">
      <h1 className="text-2xl font-bold">Who&apos;s using this phone?</h1>
      <p className="text-sm text-muted">Demo accounts. Real onboarding (phone + $BlazeTag) comes later.</p>
      {err && <p className="text-bad">✕ Needs a connection the first time.</p>}
      {users?.map((u) => (
        <button key={u.id} onClick={() => onPick(u)} className="flex items-center justify-between rounded-2xl bg-surface p-4 text-left active:bg-surface-2">
          <span>
            <span className="block font-semibold">{u.name}</span>
            <span className="text-sm text-muted">{u.tag}</span>
          </span>
          <span className={`rounded-full px-2 py-0.5 text-xs ${u.isMerchant ? "bg-accent/15 text-accent" : "bg-brand/20 text-foreground"}`}>
            {u.isMerchant ? "Vendor" : "Student"}
          </span>
        </button>
      ))}
    </main>
  );
}

export function AppHeader({ user, back }: { user: DemoUser; back?: string }) {
  return (
    <header className="flex items-center justify-between gap-2">
      {back ? (
        <Link href={back} className="rounded-full bg-surface px-3 py-1 text-sm">
          ← Back
        </Link>
      ) : (
        <div>
          <p className="text-sm text-muted">{user.isMerchant ? "Merchant mode" : "Hello"}</p>
          <p className="text-lg font-semibold">{user.isMerchant ? user.name : user.tag}</p>
        </div>
      )}
      <ConnectivityPill />
    </header>
  );
}

export const Shell = ({ children }: { children: React.ReactNode }) => (
  <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-5 px-4 pb-8 pt-[max(1rem,env(safe-area-inset-top))]">{children}</main>
);
