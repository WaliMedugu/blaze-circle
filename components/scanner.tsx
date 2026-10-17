"use client";

import { useEffect, useRef, useState } from "react";

/** Camera QR scanner. Fires onResult once, then stops. Needs HTTPS (or localhost). */
export function Scanner({ onResult, hint }: { onResult: (text: string) => void; hint: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const done = useRef(false);
  const cb = useRef(onResult);
  const [error, setError] = useState<string>();
  const [paste, setPaste] = useState("");

  useEffect(() => {
    cb.current = onResult;
  }, [onResult]);

  useEffect(() => {
    let scanner: { start(): Promise<void>; destroy(): void } | undefined;
    let cancelled = false;
    (async () => {
      const { default: QrScanner } = await import("qr-scanner");
      if (cancelled || !video.current) return;
      const s = new QrScanner(
        video.current,
        (r) => {
          if (done.current) return;
          done.current = true;
          navigator.vibrate?.(60);
          cb.current(r.data);
        },
        { returnDetailedScanResult: true, highlightScanRegion: true, preferredCamera: "environment", maxScansPerSecond: 15 },
      );
      scanner = s;
      s.start().catch(() => setError("Camera unavailable. Allow camera access, and use HTTPS on phones."));
    })();
    return () => {
      cancelled = true;
      scanner?.destroy();
    };
  }, []);

  return (
    <div className="flex flex-col gap-3">
      <div className="relative overflow-hidden rounded-3xl bg-black">
        <video ref={video} className="aspect-square w-full object-cover" muted playsInline />
        <p className="absolute inset-x-0 bottom-0 bg-black/60 p-3 text-center text-sm">{error ?? hint}</p>
      </div>
      {process.env.NODE_ENV !== "production" && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (paste.trim()) cb.current(paste.trim());
          }}
        >
          <input
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            placeholder="Dev: paste code instead"
            aria-label="Paste code"
            className="min-w-0 flex-1 rounded-xl bg-surface px-3 py-2 font-mono text-xs"
          />
          <button className="rounded-xl bg-surface-2 px-3 text-sm">Use</button>
        </form>
      )}
    </div>
  );
}
