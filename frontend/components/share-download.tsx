"use client";

import { useEffect, useState } from "react";
import { ApiError, api, type ShareInfo } from "@/lib/api";
import { extFromName, fmtBytes, TILES, FALLBACK_TILE } from "@/lib/file-transfer-engine";

const sansFont = "var(--font-space-grotesk), system-ui, sans-serif";

type DownloadState = "idle" | "downloading" | "done" | "error";

export default function ShareDownload({ token }: { token: string }) {
  const [info, setInfo] = useState<ShareInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [password, setPassword] = useState("");
  const [unlockedPassword, setUnlockedPassword] = useState<string | undefined>(undefined);
  const [unlocking, setUnlocking] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const [downloadStates, setDownloadStates] = useState<Record<string, DownloadState>>({});
  const [downloadErrors, setDownloadErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    api
      .shareInfo(token)
      .then((res) => {
        if (!cancelled) setInfo(res);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err instanceof ApiError ? err.message : "Ce lien est introuvable.");
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function unlock() {
    setUnlocking(true);
    setPasswordError(null);
    try {
      const res = await api.shareInfo(token, password);
      setInfo(res);
      setUnlockedPassword(password);
    } catch (err) {
      setPasswordError(err instanceof ApiError ? err.message : "Mot de passe incorrect.");
    } finally {
      setUnlocking(false);
    }
  }

  async function downloadFile(fileId: string, fileName: string) {
    setDownloadStates((prev) => ({ ...prev, [fileId]: "downloading" }));
    try {
      await api.downloadShare(token, fileId, fileName, unlockedPassword);
      setDownloadStates((prev) => ({ ...prev, [fileId]: "done" }));
    } catch (err) {
      setDownloadStates((prev) => ({ ...prev, [fileId]: "error" }));
      setDownloadErrors((prev) => ({
        ...prev,
        [fileId]: err instanceof ApiError ? err.message : "Échec du téléchargement.",
      }));
    }
  }

  const needsPassword = info?.requiresPassword && !info.files;
  const files = info?.files ?? [];

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#f6f4f0",
        padding: 20,
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 460,
          background: "#ffffff",
          borderRadius: 22,
          padding: 40,
          boxShadow: "0 20px 60px -34px rgba(22,24,28,.28)",
        }}
      >
        <div style={{ font: `500 16px/1 ${sansFont}`, letterSpacing: "-.01em", color: "#16181c" }}>File Moi Ça</div>

        {loadError && (
          <>
            <h1 style={{ margin: "26px 0 0", font: `400 26px/1.2 ${sansFont}`, color: "#16181c" }}>
              Lien indisponible
            </h1>
            <p style={{ marginTop: 12, font: `400 14px/1.5 ${sansFont}`, color: "#6b7178" }}>{loadError}</p>
          </>
        )}

        {!loadError && !info && (
          <p style={{ marginTop: 26, font: `400 14px/1.5 ${sansFont}`, color: "#6b7178" }}>Chargement…</p>
        )}

        {!loadError && info && (
          <>
            <h1 style={{ margin: "26px 0 0", font: `400 26px/1.2 ${sansFont}`, color: "#16181c" }}>
              {needsPassword ? "Fichiers protégés" : `${files.length} fichier${files.length > 1 ? "s" : ""}`}
            </h1>
            <p style={{ marginTop: 10, font: `400 14px/1.5 ${sansFont}`, color: "#6b7178" }}>
              Expire le {new Date(info.expiresAt).toLocaleString("fr-FR")}
            </p>

            {needsPassword && (
              <>
                <label style={{ marginTop: 22, display: "flex", flexDirection: "column", gap: 8 }}>
                  <span style={{ font: `400 13px/1 ${sansFont}`, color: "#6b7178" }}>Mot de passe</span>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="ftc-input"
                    style={{ padding: "14px 15px", borderRadius: 12, color: "#16181c", font: `400 15px/1 ${sansFont}` }}
                  />
                </label>

                {passwordError && (
                  <div style={{ marginTop: 16, font: `400 13.5px/1.4 ${sansFont}`, color: "#d2493c" }}>
                    {passwordError}
                  </div>
                )}

                <button
                  onClick={unlock}
                  disabled={unlocking || !password}
                  className="ftc-btn-primary"
                  style={{
                    marginTop: 22,
                    width: "100%",
                    padding: 16,
                    borderRadius: 99,
                    font: `500 15px/1 ${sansFont}`,
                    opacity: unlocking ? 0.7 : 1,
                  }}
                >
                  {unlocking ? "Vérification…" : "Déverrouiller"}
                </button>
              </>
            )}

            {!needsPassword && (
              <div style={{ marginTop: 22, display: "flex", flexDirection: "column", gap: 2 }}>
                {files.map((f) => {
                  const tile = TILES[extFromName(f.fileName)] || FALLBACK_TILE;
                  const state = downloadStates[f.id] ?? "idle";
                  return (
                    <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 0" }}>
                      <div
                        style={{
                          width: 36,
                          height: 36,
                          flex: "none",
                          borderRadius: 11,
                          background: tile[0],
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          font: `500 10.5px/1 ${sansFont}`,
                          color: tile[1],
                        }}
                      >
                        {extFromName(f.fileName)}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            font: `400 15px/1.25 ${sansFont}`,
                            color: "#16181c",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {f.fileName}
                        </div>
                        <div style={{ marginTop: 4, font: `400 13px/1.3 ${sansFont}`, color: "#6b7178" }}>
                          {state === "error" ? downloadErrors[f.id] : fmtBytes(f.sizeBytes)}
                        </div>
                      </div>
                      <button
                        onClick={() => downloadFile(f.id, f.fileName)}
                        disabled={state === "downloading"}
                        className={state === "done" ? "ftc-btn-secondary" : "ftc-btn-primary"}
                        style={{ padding: "10px 16px", borderRadius: 99, font: `500 13px/1 ${sansFont}`, flex: "none" }}
                      >
                        {state === "downloading" ? "…" : state === "done" ? "Retélécharger" : "Télécharger"}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
