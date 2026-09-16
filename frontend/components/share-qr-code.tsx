"use client";

import { useEffect, useRef } from "react";
import QRCode from "qrcode";

interface ShareQrCodeProps {
  url: string;
  size?: number;
}

/** Petit QR code scannable, pointant vers un lien de partage réel. */
export default function ShareQrCode({ url, size = 40 }: ShareQrCodeProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    QRCode.toCanvas(canvas, url, {
      width: size,
      margin: 0,
      color: { dark: "#16181c", light: "#ffffff" },
    }).catch(() => {
      // rendu impossible (url vide, etc.) : on laisse le canvas blanc
    });
  }, [url, size]);

  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={size}
      style={{ width: size, height: size, borderRadius: 6, flex: "none" }}
    />
  );
}
