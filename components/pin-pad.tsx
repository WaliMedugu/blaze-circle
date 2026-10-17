"use client";

import { useState } from "react";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"];

export function PinPad({ onComplete, error }: { onComplete: (pin: string) => void; error?: string }) {
  const [pin, setPin] = useState("");
  const press = (k: string) => {
    if (k === "⌫") return setPin((p) => p.slice(0, -1));
    if (!k || pin.length >= 4) return;
    const next = pin + k;
    setPin(next);
    if (next.length === 4) {
      onComplete(next);
      setTimeout(() => setPin(""), 300);
    }
  };
  return (
    <div className="flex flex-col items-center gap-4">
      <div className="flex gap-3" aria-label={`${pin.length} of 4 digits entered`}>
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={`h-4 w-4 rounded-full ${i < pin.length ? "bg-accent" : "bg-surface-2"}`} />
        ))}
      </div>
      {error && <p className="text-sm text-bad">✕ {error}</p>}
      <div className="grid w-full grid-cols-3 gap-2">
        {KEYS.map((k, i) => (
          <button
            key={i}
            type="button"
            disabled={!k}
            onClick={() => press(k)}
            aria-label={k === "⌫" ? "Delete" : k}
            className="rounded-2xl bg-surface py-4 text-2xl font-semibold disabled:opacity-0 active:bg-surface-2"
          >
            {k}
          </button>
        ))}
      </div>
    </div>
  );
}
