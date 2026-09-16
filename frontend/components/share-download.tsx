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
  /**
   * Message affiché quand le lien a cessé d'être exploitable **pendant** la
   * visite : consommé par un usage unique, ou révoqué par le déposant.
   *
   * Distinct de `loadError`, qui couvre un lien déjà mort à l'arrivée.
   */
  const [linkDead, setLinkDead] = useState<string | null>(null);

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

  /**
   * Le lien est-il encore exploitable ?
   *
   * On redemande au serveur plutôt que de le déduire : un lien à usage unique
   * meurt au dernier fichier téléchargé, et cette page n'a aucun moyen de
   * savoir seule que c'était le dernier. Le serveur, lui, le sait.
   */
  async function refreshLinkState() {
    try {
      setInfo(await api.shareInfo(token, unlockedPassword));
    } catch (err) {
      setLinkDead(
        err instanceof ApiError
          ? err.message
          : "Ce lien n'est plus exploitable.",
      );
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

    // Après coup, qu'il ait réussi ou échoué : c'est le téléchargement qui
    // vient peut-être de consumer le lien, et le refus suivant doit être une
    // page claire plutôt qu'un bouton qui ne marche plus.
    await refreshLinkState();
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

        {!loadError && linkDead && (
          <>
            <h1 style={{ margin: "26px 0 0", font: `400 26px/1.2 ${sansFont}`, color: "#16181c" }}>
              Lien épuisé
            </h1>
            <p style={{ marginTop: 12, font: `400 14px/1.5 ${sansFont}`, color: "#6b7178" }}>{linkDead}</p>
            <p style={{ marginTop: 10, font: `400 14px/1.5 ${sansFont}`, color: "#6b7178" }}>
              Les fichiers déjà téléchargés restent sur votre appareil. Pour les
              obtenir de nouveau, demandez un nouveau lien à l&apos;expéditeur.
            </p>
          </>
        )}

        {!loadError && !linkDead && !info && (
          <p style={{ marginTop: 26, font: `400 14px/1.5 ${sansFont}`, color: "#6b7178" }}>Chargement…</p>
        )}

        {!loadError && !linkDead && info && (
          <>
            <h1 style={{ margin: "26px 0 0", font: `400 26px/1.2 ${sansFont}`, color: "#16181c" }}>
              {(() => {
                if (needsPassword) return "Fichiers protégés";
                if (files.length === 0) return "Lien sans objet";
                return `${files.length} fichier${files.length > 1 ? "s" : ""}`;
              })()}
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

            {!needsPassword && files.length === 0 && (
              <p style={{ marginTop: 22, font: `400 14px/1.5 ${sansFont}`, color: "#6b7178" }}>
                Ce lien ne contient plus aucun fichier : l&apos;expéditeur les a
                supprimés. Demandez-lui un nouveau lien.
              </p>
            )}

            {!needsPassword && files.length > 0 && (
              <div style={{ marginTop: 22, display: "flex", flexDirection: "column", gap: 2 }}>
                {files.map((f) => {
                  const tile = TILES[extFromName(f.fileName)] || FALLBACK_TILE;
                  const state = downloadStates[f.id] ?? "idle";
                  // Sur un lien à usage unique, chaque fichier ne part qu'une
                  // fois : reproposer le téléchargement ne mènerait qu'à un
                  // refus du serveur.
                  const epuise = Boolean(info?.singleUse) && state === "done";
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
                          {state === "error"
                            ? downloadErrors[f.id]
                            : epuise
                              ? "Déjà récupéré — ce lien ne le sert qu'une fois"
                              : fmtBytes(f.sizeBytes)}
                        </div>
                      </div>
                      <button
                        onClick={() => downloadFile(f.id, f.fileName)}
                        disabled={state === "downloading" || epuise}
                        className={state === "done" ? "ftc-btn-secondary" : "ftc-btn-primary"}
                        style={{
                          padding: "10px 16px",
                          borderRadius: 99,
                          font: `500 13px/1 ${sansFont}`,
                          flex: "none",
                          opacity: epuise ? 0.45 : 1,
                          cursor: epuise ? "default" : undefined,
                        }}
                      >
                        {(() => {
                          if (state === "downloading") return "…";
                          if (epuise) return "Téléchargé";
                          if (state === "done") return "Retélécharger";
                          return "Télécharger";
                        })()}
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
