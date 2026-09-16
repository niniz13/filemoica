"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CAT,
  type Screen,
  TILES,
  createEngine,
  dropPacket,
  drawEngine,
  drawQR,
  fmt,
  stepEngine,
} from "@/lib/file-transfer-engine";

const ACCENT = "#5b4bff";
const WAVE_INTENSITY = 1;
const DEMO_SPEED = 1;

type Expiry = "7 days" | "24 hours";

const NAV: { id: Screen; label: string; meta: string }[] = [
  { id: "drop", label: "Send", meta: "" },
  { id: "sent", label: "Transfers", meta: "3" },
  { id: "receive", label: "Received", meta: "1" },
  { id: "signin", label: "Account", meta: "" },
];

export default function FileTransferApp() {
  const [screen, setScreen] = useState<Screen>("signin");
  const [fileIdxs, setFileIdxs] = useState<number[]>([0, 1, 2]);
  const [narrow, setNarrow] = useState(false);
  const [copied, setCopied] = useState(false);
  const [draining, setDraining] = useState(false);
  const [expiry, setExpiry] = useState<Expiry>("7 days");
  const [pwd, setPwd] = useState(false);
  const [burn, setBurn] = useState(true);
  const [live, setLive] = useState({ p: 0, level: 0, t: 0 });

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef(createEngine());
  const liveRef = useRef({ screen, fileCount: fileIdxs.length, draining });

  useEffect(() => {
    liveRef.current = { screen, fileCount: fileIdxs.length, draining };
  }, [screen, fileIdxs.length, draining]);

  useEffect(() => {
    const engine = engineRef.current;
    let last = performance.now();

    function completeSending() {
      engine.p = 1;
      setScreen("sent");
      setCopied(false);
    }

    function loop(now: number) {
      const dt = Math.min(20, now - last);
      last = now;
      engine.t += dt;
      stepEngine(engine, dt, liveRef.current, WAVE_INTENSITY, DEMO_SPEED, completeSending);
      const canvas = canvasRef.current;
      if (canvas) drawEngine(engine, canvas, ACCENT);
      if (now - engine.lastUI > 100) {
        engine.lastUI = now;
        setLive({ p: engine.p, level: engine.level ?? 0, t: engine.t });
      }
      engine.raf = requestAnimationFrame(loop);
    }

    engine.raf = requestAnimationFrame(loop);

    const onResize = () => setNarrow(window.innerWidth < 880);
    window.addEventListener("resize", onResize);
    onResize();

    return () => {
      cancelAnimationFrame(engine.raf);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  const handleQrRef = useCallback((el: HTMLCanvasElement | null) => {
    if (el) drawQR(el);
  }, []);

  function goToScreen(next: Screen) {
    if (next === screen) return;
    const engine = engineRef.current;
    if (next === "drop") engine.p = 0;
    if (next === "sending") {
      engine.p = 0;
      fileIdxs.forEach((fi, i) => {
        setTimeout(() => dropPacket(engine, CAT[fi].ext, CAT[fi].mb), i * 260);
      });
    }
    if (next === "sent") engine.p = 1;
    if (next === "receive") {
      engine.p = 1;
      setDraining(false);
    }
    setScreen(next);
    setCopied(false);
    setLive((v) => ({ ...v, p: engine.p }));
  }

  function addFile() {
    if (fileIdxs.length >= CAT.length) return;
    const nx = fileIdxs.length;
    setFileIdxs((prev) => [...prev, nx]);
    const f = CAT[nx];
    dropPacket(engineRef.current, f.ext, f.mb);
  }

  function addFolder() {
    const add = [3, 4, 5].filter((i) => !fileIdxs.includes(i)).slice(0, 2);
    if (!add.length) return;
    setFileIdxs((prev) => [...prev, ...add]);
    add.forEach((i, k) => {
      setTimeout(() => dropPacket(engineRef.current, CAT[i].ext, CAT[i].mb), k * 220);
    });
  }

  function startSend() {
    goToScreen("sending");
  }
  function startDrain() {
    setDraining(true);
  }
  function resetReceive() {
    engineRef.current.p = 1;
    setDraining(false);
    setLive((v) => ({ ...v, p: 1 }));
  }
  function resetAll() {
    engineRef.current.p = 0;
    setFileIdxs([0, 1, 2]);
    setScreen("drop");
    setCopied(false);
    setLive((v) => ({ ...v, p: 0 }));
  }
  function copyLink() {
    setCopied(true);
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText("https://filemoca.app/d/7QX-4KP-9ZB").catch(() => {});
    }
  }
  const p = live.p;
  const level = live.level;
  const files = fileIdxs.map((i) => CAT[i]);
  const totalMb = files.reduce((a, f) => a + f.mb, 0);
  const pct =
    screen === "sending" ? p : screen === "sent" ? 1 : screen === "receive" ? p : Math.min(0.99, totalMb / 12000);

  const isSignin = screen === "signin";
  const isDrop = screen === "drop";
  const isSending = screen === "sending";
  const isSent = screen === "sent";
  const isReceive = screen === "receive";
  const wide = !narrow;

  const rows = files.map((f, i) => {
    let prog = 0;
    let status = "Waiting";
    let statusColor = "#6b7178";
    if (isDrop) {
      prog = 1;
      status = "Ready";
      statusColor = "#6b7178";
    } else if (isSending) {
      const seg = 1 / files.length;
      const local = (p - i * seg) / seg;
      prog = Math.max(0, Math.min(1, local));
      status = prog >= 1 ? "Uploaded" : prog <= 0 ? "Waiting" : Math.round(prog * 100) + "%";
      statusColor = prog >= 1 ? "#0b6b45" : prog > 0 ? "#5b4bff" : "#6b7178";
    } else if (isSent) {
      prog = 1;
      status = "Sent";
      statusColor = "#0b6b45";
    } else if (isReceive) {
      const seg = 1 / files.length;
      const local = (1 - p - i * seg) / seg;
      prog = draining ? Math.max(0, Math.min(1, local)) : 0;
      status = !draining ? "Ready" : prog >= 1 ? "Saved" : Math.round(prog * 100) + "%";
      statusColor = prog >= 1 ? "#0b6b45" : draining ? "#5b4bff" : "#6b7178";
    }
    const tile = TILES[f.ext] || ["#efece7", "#6b7178"];
    return {
      key: f.name + i,
      name: f.name,
      ext: f.ext,
      sub: f.kind + " · " + fmt(f.mb),
      status,
      statusColor,
      tileBg: tile[0],
      tileFg: tile[1],
    };
  });

  const mbDone = totalMb * (isReceive ? 1 - p : p);
  const rate = 86 + Math.sin(live.t / 700) * 14;

  const topInk = level > 0.82 ? "#ffffff" : "#16181c";
  const topMuted = level > 0.82 ? "#ffffff" : "#6b7178";
  const botInk = level > 0.2 ? "#ffffff" : "#16181c";
  const botMuted = level > 0.2 ? "#ffffff" : "#6b7178";

  const headTitle = isDrop ? "New transfer" : isSending ? "Sending" : isSent ? "All done" : "Sent to you";
  const headSub = isDrop
    ? "Up to 100 GB, no signup needed"
    : isSending
      ? "You can pause and resume anytime"
      : isSent
        ? "Expires in " + expiry
        : "2 minutes ago";

  const drainLabel = draining ? (p <= 0 ? "Saved to your device" : "Downloading…") : "Download all";
  const receiveHead = draining ? (p <= 0 ? "All done. Enjoy." : "Downloading your files.") : "3 files waiting for you.";

  const opts = [
    {
      label: expiry === "7 days" ? "Expires in 7 days" : "Expires in 24 hours",
      bg: "#f6f4f0",
      fg: "#3b4046",
      onClick: () => setExpiry(expiry === "7 days" ? "24 hours" : "7 days"),
    },
    {
      label: "Password",
      bg: pwd ? "#ece9ff" : "#f6f4f0",
      fg: pwd ? "#3527cc" : "#3b4046",
      onClick: () => setPwd((v) => !v),
    },
    {
      label: "Delete after download",
      bg: burn ? "#ece9ff" : "#f6f4f0",
      fg: burn ? "#3527cc" : "#3b4046",
      onClick: () => setBurn((v) => !v),
    },
  ];

  const sentMeta = [
    { k: "Size", v: fmt(totalMb) },
    { k: "Expires", v: expiry },
    { k: "Password", v: pwd ? "On" : "Off" },
    { k: "Delete after download", v: burn ? "On" : "Off" },
  ];

  const recvMeta = [
    { k: "Files", v: String(files.length) },
    { k: "Size", v: fmt(totalMb) },
    { k: "Expires", v: "In 6 days" },
    { k: "Downloads left", v: "1" },
  ];

  const listMeta = files.length + " files · " + fmt(totalMb);
  const pctLabel = Math.round(pct * 100) + "%";
  const pctWidth = Math.round(p * 100) + "%";
  const stateLabel = isDrop
    ? "Ready to send"
    : isSending
      ? "Uploading"
      : isSent
        ? "Sent"
        : isReceive
          ? draining
            ? "Downloading"
            : "Ready"
          : "";
  const sentLabel = fmt(mbDone) + " of " + fmt(totalMb);
  const etaLabel = isSending ? Math.max(1, Math.round((1 - p) * 74)) + " seconds left" : "";
  const sendingNote =
    "Uploading at " + rate.toFixed(0) + " MB/s. You can close this tab, we will email you the link when it is done.";

  const sansFont = "var(--font-space-grotesk), system-ui, sans-serif";
  const monoFont = "var(--font-ibm-plex-mono), monospace";

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", background: "#ffffff" }}>
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          {isSignin && (
            <div style={{ flex: 1, display: "flex", flexWrap: "wrap", minHeight: 0 }}>
              <div
                style={{
                  flex: "1 1 320px",
                  minWidth: 280,
                  position: "relative",
                  minHeight: 340,
                  overflow: "hidden",
                  background: "#f1eee9",
                }}
              >
                <canvas
                  ref={canvasRef}
                  style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block" }}
                />
                <div style={{ position: "absolute", left: 40, top: 40, right: 40, zIndex: 2 }}>
                  <div style={{ font: `500 17px/1 ${sansFont}`, letterSpacing: "-.01em" }}>File Moi Ça</div>
                  <p
                    style={{
                      margin: "26px 0 0",
                      maxWidth: 320,
                      font: `300 34px/1.14 ${sansFont}`,
                      letterSpacing: "-.03em",
                      color: "#16181c",
                    }}
                  >
                    Send big files in one drop.
                  </p>
                  <p
                    style={{
                      margin: "16px 0 0",
                      maxWidth: 290,
                      font: `400 15px/1.55 ${sansFont}`,
                      color: "#6b7178",
                    }}
                  >
                    Drop your files, get a link, share it anywhere. Up to 100 GB per transfer.
                  </p>
                </div>
              </div>
              <div
                style={{
                  flex: "1 1 360px",
                  minWidth: 300,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: "56px 40px",
                }}
              >
                <div style={{ width: "100%", maxWidth: 330, animation: "rise .5s ease both" }}>
                  <h1 style={{ margin: 0, font: `400 28px/1.15 ${sansFont}`, letterSpacing: "-.03em" }}>
                    Welcome back
                  </h1>
                  <div style={{ marginTop: 32, display: "flex", flexDirection: "column", gap: 16 }}>
                    <label style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      <span style={{ font: `400 13px/1 ${sansFont}`, color: "#6b7178" }}>Email</span>
                      <input
                        type="text"
                        defaultValue="amelie@studiolune.fr"
                        className="ftc-input"
                        style={{
                          padding: "14px 15px",
                          borderRadius: 12,
                          color: "#16181c",
                          font: `400 15px/1 ${sansFont}`,
                        }}
                      />
                    </label>
                    <label style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      <span style={{ font: `400 13px/1 ${sansFont}`, color: "#6b7178" }}>Password</span>
                      <input
                        type="password"
                        defaultValue="mypassword123"
                        className="ftc-input"
                        style={{
                          padding: "14px 15px",
                          borderRadius: 12,
                          color: "#16181c",
                          font: `400 15px/1 ${sansFont}`,
                        }}
                      />
                    </label>
                  </div>
                  <button
                    onClick={() => goToScreen("drop")}
                    className="ftc-btn-primary"
                    style={{
                      marginTop: 26,
                      width: "100%",
                      padding: 16,
                      borderRadius: 99,
                      font: `500 15px/1 ${sansFont}`,
                    }}
                  >
                    Continue
                  </button>
                  <button
                    onClick={() => goToScreen("drop")}
                    className="ftc-btn-text"
                    style={{ marginTop: 10, width: "100%", padding: 15, borderRadius: 99, font: `400 14px/1 ${sansFont}` }}
                  >
                    Email me a sign-in link
                  </button>
                </div>
              </div>
            </div>
          )}

          {!isSignin && (
            <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
              {wide && (
                <div style={{ width: 216, flex: "none", padding: "32px 20px", display: "flex", flexDirection: "column", background: "#fbfaf8" }}>
                  <div style={{ font: `500 16px/1 ${sansFont}`, letterSpacing: "-.01em", paddingLeft: 10 }}>File Moi Ça</div>
                  <div style={{ marginTop: 32, display: "flex", flexDirection: "column", gap: 4 }}>
                    {NAV.map((n) => (
                      <button
                        key={n.id}
                        onClick={() => goToScreen(n.id)}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 8,
                          padding: "11px 12px",
                          border: "none",
                          borderRadius: 11,
                          background: screen === n.id ? "#ece9ff" : "transparent",
                          color: screen === n.id ? "#3527cc" : "#3b4046",
                          font: `400 14.5px/1 ${sansFont}`,
                          cursor: "pointer",
                          textAlign: "left",
                        }}
                      >
                        {n.label}
                        <span style={{ font: `400 12.5px/1 ${sansFont}`, color: "#565c63" }}>{n.meta}</span>
                      </button>
                    ))}
                  </div>
                  <span style={{ flex: 1 }} />
                  <div style={{ padding: "0 12px" }}>
                    <div style={{ font: `400 13px/1 ${sansFont}`, color: "#6b7178" }}>12 GB of 100 GB</div>
                    <div style={{ marginTop: 10, height: 5, borderRadius: 99, background: "rgba(22,24,28,.08)", overflow: "hidden" }}>
                      <div style={{ height: "100%", width: "12%", background: "#5b4bff", borderRadius: 99 }} />
                    </div>
                  </div>
                  <div style={{ marginTop: 26, display: "flex", alignItems: "center", gap: 10, padding: "0 12px" }}>
                    <div
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: "50%",
                        background: "#ece9ff",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        font: `500 12.5px/1 ${sansFont}`,
                        color: "#5b4bff",
                      }}
                    >
                      AM
                    </div>
                    <div style={{ font: `400 13px/1.3 ${sansFont}`, color: "#6b7178", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                      Amélie
                    </div>
                  </div>
                </div>
              )}

              <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap", padding: "32px 32px 22px" }}>
                  <div style={{ font: `400 22px/1.15 ${sansFont}`, letterSpacing: "-.025em" }}>{headTitle}</div>
                  <div style={{ font: `400 14px/1.4 ${sansFont}`, color: "#6b7178" }}>{headSub}</div>
                </div>

                <div style={{ flex: 1, display: "flex", flexWrap: "wrap", minHeight: 0, alignItems: "stretch", gap: 0 }}>
                  <div style={{ flex: "1 1 400px", minWidth: 290, position: "relative", minHeight: 380, overflow: "hidden", background: "#f1eee9" }}>
                    <canvas
                      ref={canvasRef}
                      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block" }}
                    />

                    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", padding: 32, pointerEvents: "none" }}>
                      <div style={{ display: "flex", justifyContent: "flex-end" }}>
                        <div style={{ textAlign: "right" }}>
                          <div
                            style={{
                              font: `300 52px/1 ${sansFont}`,
                              letterSpacing: "-.04em",
                              fontVariantNumeric: "tabular-nums",
                              color: topInk,
                            }}
                          >
                            {pctLabel}
                          </div>
                          <div style={{ marginTop: 8, font: `400 14px/1 ${sansFont}`, color: topMuted }}>{stateLabel}</div>
                        </div>
                      </div>
                      <span style={{ flex: 1 }} />

                      {isDrop && (
                        <div style={{ pointerEvents: "auto", alignSelf: "flex-start", maxWidth: 340 }}>
                          <div style={{ font: `300 30px/1.14 ${sansFont}`, letterSpacing: "-.03em", color: botInk }}>
                            Drop your files here.
                          </div>
                          <div style={{ display: "flex", gap: 10, marginTop: 22, flexWrap: "wrap" }}>
                            <button
                              onClick={addFile}
                              className="ftc-btn-primary"
                              style={{ padding: "14px 22px", borderRadius: 99, font: `500 14.5px/1 ${sansFont}` }}
                            >
                              Choose files
                            </button>
                            <button
                              onClick={addFolder}
                              className="ftc-btn-secondary"
                              style={{ padding: "14px 20px", borderRadius: 99, font: `400 14.5px/1 ${sansFont}` }}
                            >
                              Add a folder
                            </button>
                          </div>
                        </div>
                      )}

                      {isSending && (
                        <div style={{ pointerEvents: "auto", display: "flex", alignItems: "flex-end", gap: 18, flexWrap: "wrap" }}>
                          <div style={{ flex: 1, minWidth: 190 }}>
                            <div style={{ height: 6, borderRadius: 99, background: "rgba(22,24,28,.1)", overflow: "hidden" }}>
                              <div style={{ height: "100%", width: pctWidth, background: "#5b4bff", borderRadius: 99 }} />
                            </div>
                            <div
                              style={{
                                marginTop: 12,
                                display: "flex",
                                justifyContent: "space-between",
                                gap: 12,
                                font: `400 14px/1 ${sansFont}`,
                                color: botMuted,
                              }}
                            >
                              <span>{sentLabel}</span>
                              <span>{etaLabel}</span>
                            </div>
                          </div>
                          <button
                            onClick={() => goToScreen("sent")}
                            className="ftc-btn-secondary"
                            style={{ padding: "12px 18px", borderRadius: 99, font: `400 14px/1 ${sansFont}` }}
                          >
                            Skip ahead
                          </button>
                        </div>
                      )}

                      {isSent && (
                        <div style={{ pointerEvents: "auto", maxWidth: 340 }}>
                          <div style={{ font: `300 30px/1.14 ${sansFont}`, letterSpacing: "-.03em", color: botInk }}>
                            Your link is ready to share.
                          </div>
                        </div>
                      )}

                      {isReceive && (
                        <div style={{ pointerEvents: "auto", maxWidth: 350 }}>
                          <div style={{ font: `400 14px/1 ${sansFont}`, color: botMuted }}>From Amélie</div>
                          <div style={{ marginTop: 14, font: `300 30px/1.14 ${sansFont}`, letterSpacing: "-.03em", color: botInk }}>
                            {receiveHead}
                          </div>
                          <div style={{ display: "flex", gap: 10, marginTop: 22, flexWrap: "wrap" }}>
                            <button
                              onClick={startDrain}
                              className="ftc-btn-primary"
                              style={{ padding: "14px 22px", borderRadius: 99, font: `500 14.5px/1 ${sansFont}` }}
                            >
                              {drainLabel}
                            </button>
                            <button
                              onClick={resetReceive}
                              className="ftc-btn-secondary"
                              style={{ padding: "14px 20px", borderRadius: 99, font: `400 14.5px/1 ${sansFont}` }}
                            >
                              Replay
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  <div style={{ flex: "1 1 340px", minWidth: 290, display: "flex", flexDirection: "column", minHeight: 0, background: "#ffffff", padding: "0 26px 26px" }}>
                    <div style={{ padding: "6px 6px 14px", font: `400 14px/1 ${sansFont}`, color: "#6b7178" }}>{listMeta}</div>

                    <div style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column", gap: 2, minHeight: 130 }}>
                      {rows.map((f) => (
                        <div key={f.key} style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 6px" }}>
                          <div
                            style={{
                              width: 36,
                              height: 36,
                              flex: "none",
                              borderRadius: 11,
                              background: f.tileBg,
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              font: `500 10.5px/1 ${sansFont}`,
                              color: f.tileFg,
                            }}
                          >
                            {f.ext}
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ font: `400 15px/1.25 ${sansFont}`, color: "#16181c", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {f.name}
                            </div>
                            <div style={{ marginTop: 4, font: `400 13px/1.3 ${sansFont}`, color: "#6b7178" }}>{f.sub}</div>
                          </div>
                          <div style={{ font: `400 13px/1 ${sansFont}`, color: f.statusColor, textAlign: "right", flex: "none" }}>
                            {f.status}
                          </div>
                        </div>
                      ))}
                    </div>

                    {isDrop && (
                      <div style={{ paddingTop: 20, display: "flex", flexDirection: "column", gap: 16 }}>
                        <label style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                          <span style={{ font: `400 13px/1 ${sansFont}`, color: "#6b7178" }}>Send to</span>
                          <input
                            type="text"
                            defaultValue="marc@atelier-nord.be"
                            className="ftc-input"
                            style={{ padding: "14px 15px", borderRadius: 12, color: "#16181c", font: `400 15px/1 ${sansFont}` }}
                          />
                        </label>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          {opts.map((o) => (
                            <button
                              key={o.label}
                              onClick={o.onClick}
                              style={{
                                padding: "9px 15px",
                                borderRadius: 99,
                                border: "none",
                                background: o.bg,
                                color: o.fg,
                                font: `400 13.5px/1 ${sansFont}`,
                                cursor: "pointer",
                              }}
                            >
                              {o.label}
                            </button>
                          ))}
                        </div>
                        <button
                          onClick={startSend}
                          className="ftc-btn-primary"
                          style={{ padding: 17, borderRadius: 99, font: `500 15px/1 ${sansFont}` }}
                        >
                          Upload and get a link
                        </button>
                      </div>
                    )}

                    {isSending && (
                      <div style={{ paddingTop: 20, font: `400 14px/1.6 ${sansFont}`, color: "#6b7178" }}>{sendingNote}</div>
                    )}

                    {isSent && (
                      <div style={{ paddingTop: 20, display: "flex", flexDirection: "column", gap: 16 }}>
                        <div style={{ padding: 18, borderRadius: 16, background: "#f6f4f0" }}>
                          <div style={{ display: "flex", gap: 18, alignItems: "flex-start", flexWrap: "wrap" }}>
                            <div style={{ flex: 1, minWidth: 150 }}>
                              <div style={{ font: `400 13px/1 ${sansFont}`, color: "#6b7178" }}>Your link</div>
                              <div style={{ marginTop: 10, font: `400 14.5px/1.5 ${monoFont}`, color: "#16181c", wordBreak: "break-all" }}>
                                filemoca.app/d/7QX-4KP-9ZB
                              </div>
                              <div style={{ marginTop: 10, font: `400 13px/1.5 ${sansFont}`, color: "#6b7178" }}>
                                Scan the code to download on a phone.
                              </div>
                            </div>
                            <canvas
                              ref={handleQrRef}
                              style={{ width: 132, height: 132, flex: "none", borderRadius: 12, background: "#fff", boxShadow: "0 2px 12px -8px rgba(22,24,28,.5)" }}
                            />
                          </div>
                          <div style={{ display: "flex", gap: 10, marginTop: 16, flexWrap: "wrap" }}>
                            <button
                              onClick={copyLink}
                              className="ftc-btn-primary"
                              style={{ flex: 1, minWidth: 120, padding: 13, borderRadius: 99, font: `500 14px/1 ${sansFont}` }}
                            >
                              {copied ? "Copied" : "Copy link"}
                            </button>
                            <button
                              onClick={() => goToScreen("receive")}
                              className="ftc-btn-secondary-alt"
                              style={{ padding: "13px 18px", borderRadius: 99, font: `400 14px/1 ${sansFont}` }}
                            >
                              See it as they do
                            </button>
                          </div>
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                          {sentMeta.map((m) => (
                            <div key={m.k} style={{ display: "flex", justifyContent: "space-between", gap: 12, font: `400 14px/1 ${sansFont}` }}>
                              <span style={{ color: "#6b7178" }}>{m.k}</span>
                              <span style={{ color: "#3b4046" }}>{m.v}</span>
                            </div>
                          ))}
                        </div>
                        <button
                          onClick={resetAll}
                          className="ftc-btn-text"
                          style={{ padding: 15, borderRadius: 99, font: `400 14px/1 ${sansFont}` }}
                        >
                          Start a new transfer
                        </button>
                      </div>
                    )}

                    {isReceive && (
                      <div style={{ paddingTop: 20, display: "flex", flexDirection: "column", gap: 14 }}>
                        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                          {recvMeta.map((m) => (
                            <div key={m.k} style={{ display: "flex", justifyContent: "space-between", gap: 12, font: `400 14px/1 ${sansFont}` }}>
                              <span style={{ color: "#6b7178" }}>{m.k}</span>
                              <span style={{ color: "#3b4046" }}>{m.v}</span>
                            </div>
                          ))}
                        </div>
                        <div style={{ font: `400 13.5px/1.6 ${sansFont}`, color: "#6b7178" }}>
                          Files stay available for 6 more days, then they are deleted automatically.
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
      </div>
    </div>
  );
}
