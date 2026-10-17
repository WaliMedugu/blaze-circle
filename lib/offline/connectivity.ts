"use client";

import { useEffect, useState } from "react";
import { isForcedOffline } from "@/lib/client/api";

// navigator.onLine lies on captive / no-upstream Wi-Fi, so we confirm with a real round trip.
export type Connectivity = "online" | "weak" | "offline";

const PING_EVERY_MS = 5_000;
const TIMEOUT_MS = 3_000;
const WEAK_MS = 1_500;

async function probe(): Promise<Connectivity> {
  if (isForcedOffline() || !navigator.onLine) return "offline";
  const started = performance.now();
  try {
    const res = await fetch(`/api/health?t=${Date.now()}`, { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return "offline";
    return performance.now() - started > WEAK_MS ? "weak" : "online";
  } catch {
    return "offline";
  }
}

export function useConnectivity(): Connectivity {
  const [state, setState] = useState<Connectivity>("online");
  useEffect(() => {
    let alive = true;
    const run = () => probe().then((s) => alive && setState(s));
    run();
    const id = setInterval(run, PING_EVERY_MS);
    window.addEventListener("online", run);
    window.addEventListener("offline", run);
    window.addEventListener("blaze:connectivity", run);
    document.addEventListener("visibilitychange", run);
    return () => {
      alive = false;
      clearInterval(id);
      window.removeEventListener("online", run);
      window.removeEventListener("offline", run);
      window.removeEventListener("blaze:connectivity", run);
      document.removeEventListener("visibilitychange", run);
    };
  }, []);
  return state;
}
