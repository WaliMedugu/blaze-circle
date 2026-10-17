"use client";

import QRCode from "qrcode";
import { useEffect, useState } from "react";

/** White quiet zone + low error correction: densest code that phone cameras still read from a screen. */
export function QrCode({ value, label }: { value: string; label: string }) {
  const [src, setSrc] = useState<string>();
  useEffect(() => {
    QRCode.toDataURL(value, { errorCorrectionLevel: "L", margin: 2, width: 640 }).then(setSrc, () => setSrc(undefined));
  }, [value]);
  return (
    <div className="mx-auto w-full max-w-[320px] rounded-3xl bg-white p-3" data-payload={value} data-testid="qr">
      {/* eslint-disable-next-line @next/next/no-img-element -- data URL, nothing to optimise */}
      {src ? <img src={src} alt={label} className="aspect-square w-full" /> : <div className="aspect-square w-full" />}
    </div>
  );
}
