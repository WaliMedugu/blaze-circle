"use client";

import { useConnectivity } from "@/lib/offline/connectivity";

// Color + icon + word, never color alone.
const LOOK = {
  online: { dot: "●", label: "Online", cls: "bg-ok/15 text-ok" },
  weak: { dot: "◐", label: "Weak signal", cls: "bg-warn/15 text-warn" },
  offline: { dot: "○", label: "Offline · Pocket mode", cls: "bg-surface-2 text-accent" },
} as const;

export function ConnectivityPill() {
  const look = LOOK[useConnectivity()];
  return (
    <span role="status" aria-live="polite" className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-medium ${look.cls}`}>
      <span aria-hidden>{look.dot}</span>
      {look.label}
    </span>
  );
}
