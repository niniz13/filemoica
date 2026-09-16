"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  ApiError,
  api,
  type CurrentUser,
  type FileItem,
  type ManagedUser,
  type Quota,
  type ServiceStats,
} from "@/lib/api";
import ShareQrCode from "@/components/share-qr-code";
import {
  FALLBACK_TILE,
  TILES,
  createEngine,
  dropPacket,
  drawEngine,
  extFromName,
  fmtBytes,
  stepEngine,
  type EnginePhase,
} from "@/lib/file-transfer-engine";

const ACCENT = "#5b4bff";
const WAVE_INTENSITY = 1;

type Screen = "signin" | "drop" | "files" | "account" | "admin";
type AuthMode = "login" | "register";

interface UploadItem {
  id: string;
  fileId?: string;
  name: string;
  sizeBytes: number;
  progress: number;
  status: "uploading" | "done" | "error";
  error?: string;
}

/** Un lien de partage créé pour toute une sélection de fichiers de la session. */
interface SessionShare {
  id: string;
  url: string;
  fileNames: string[];
}

/** Durée de validité par défaut d'un lien de partage. */
const DEFAULT_SHARE_HOURS = 72;

const NAV: { id: Screen; label: string }[] = [
  { id: "drop", label: "Envoyer" },
  { id: "files", label: "Mes fichiers" },
  { id: "account", label: "Compte" },
];

export default function FileTransferApp() {
  const [screen, setScreen] = useState<Screen>("signin");
  const [authChecked, setAuthChecked] = useState(false);
  const [user, setUser] = useState<CurrentUser | null>(null);

  const [authMode, setAuthMode] = useState<AuthMode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);

  const [quota, setQuota] = useState<Quota | null>(null);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [adminStats, setAdminStats] = useState<ServiceStats | null>(null);
  const [adminUsers, setAdminUsers] = useState<ManagedUser[]>([]);
  const [adminLoading, setAdminLoading] = useState(false);
  const [adminError, setAdminError] = useState<string | null>(null);
  const [adminActionId, setAdminActionId] = useState<string | null>(null);

  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [sessionShares, setSessionShares] = useState<SessionShare[]>([]);
  const [claimedFileIds, setClaimedFileIds] = useState<Set<string>>(new Set());
  const [shareBusy, setShareBusy] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [copiedShareId, setCopiedShareId] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const [narrow, setNarrow] = useState(false);
  const [live, setLive] = useState({ level: 0, t: 0 });

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef(createEngine());
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  const isUploading = uploads.some((u) => u.status === "uploading");
  const quotaFraction = quota && quota.limitBytes > 0 ? quota.usedBytes / quota.limitBytes : 0;

  const liveCtxRef = useRef<{ phase: EnginePhase; quotaFraction: number }>({
    phase: "signin",
    quotaFraction: 0,
  });

  useEffect(() => {
    const phase: EnginePhase = screen === "signin" ? "signin" : isUploading ? "active" : "idle";
    liveCtxRef.current = { phase, quotaFraction };
  }, [screen, isUploading, quotaFraction]);

  const refreshQuota = useCallback(async () => {
    try {
      setQuota(await api.quota());
    } catch {
      // le quota n'est pas critique pour l'affichage, on ignore l'échec
    }
  }, []);

  const refreshFiles = useCallback(async () => {
    setFilesLoading(true);
    try {
      setFiles(await api.listFiles());
      setFilesError(null);
    } catch (err) {
      setFilesError(err instanceof ApiError ? err.message : "Impossible de charger les fichiers.");
    } finally {
      setFilesLoading(false);
    }
  }, []);

  const refreshAdmin = useCallback(async () => {
    setAdminLoading(true);
    try {
      const [stats, users] = await Promise.all([api.adminStats(), api.adminListUsers()]);
      setAdminStats(stats);
      setAdminUsers(users);
      setAdminError(null);
    } catch (err) {
      setAdminError(err instanceof ApiError ? err.message : "Impossible de charger l'administration.");
    } finally {
      setAdminLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const me = await api.me();
        if (cancelled) return;
        setUser(me);
        setScreen("drop");
        void refreshQuota();
        void refreshFiles();
      } catch {
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setAuthChecked(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshQuota, refreshFiles]);

  useEffect(() => {
    const engine = engineRef.current;
    let last = performance.now();

    function loop(now: number) {
      const dt = Math.min(20, now - last);
      last = now;
      engine.t += dt;
      stepEngine(engine, dt, liveCtxRef.current, WAVE_INTENSITY);
      const canvas = canvasRef.current;
      if (canvas) drawEngine(engine, canvas, ACCENT);
      if (now - engine.lastUI > 100) {
        engine.lastUI = now;
        setLive({ level: engine.level ?? 0, t: engine.t });
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

  async function submitAuth(e: FormEvent) {
    e.preventDefault();
    setAuthBusy(true);
    setAuthError(null);
    try {
      if (authMode === "register") {
        await api.register(email, password);
      }
      const loggedIn = await api.login(email, password);
      setUser(loggedIn);
      setScreen("drop");
      setPassword("");
      void refreshQuota();
      void refreshFiles();
    } catch (err) {
      setAuthError(err instanceof ApiError ? err.message : "Une erreur est survenue.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleLogout() {
    try {
      await api.logout();
    } catch {
      // on ferme la session côté client même si l'appel échoue
    }
    setUser(null);
    setQuota(null);
    setFiles([]);
    setUploads([]);
    setSessionShares([]);
    setClaimedFileIds(new Set());
    setShareError(null);
    setAdminStats(null);
    setAdminUsers([]);
    setAdminError(null);
    setEmail("");
    setPassword("");
    setAuthMode("login");
    setScreen("signin");
  }

  function uploadOne(file: File) {
    const id = crypto.randomUUID();
    setUploads((prev) => [{ id, name: file.name, sizeBytes: file.size, progress: 0, status: "uploading" }, ...prev]);
    dropPacket(engineRef.current, extFromName(file.name), file.size / (1024 * 1024));
    engineRef.current.p = 0;

    api
      .uploadFile(file, (fraction) => {
        engineRef.current.p = fraction;
        setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, progress: fraction } : u)));
      })
      .then((uploaded) => {
        setUploads((prev) =>
          prev.map((u) => (u.id === id ? { ...u, fileId: uploaded.id, progress: 1, status: "done" } : u)),
        );
        setFiles((prev) => [uploaded, ...prev]);
        void refreshQuota();
      })
      .catch((err) => {
        setUploads((prev) =>
          prev.map((u) =>
            u.id === id
              ? {
                  ...u,
                  status: "error",
                  error: err instanceof ApiError ? err.message : "Échec de l'envoi.",
                }
              : u,
          ),
        );
      });
  }

  function handleFilesSelected(list: FileList | File[]) {
    Array.from(list).forEach(uploadOne);
  }

  function goToScreen(next: Screen) {
    setScreen(next);
    if (next === "admin") void refreshAdmin();
  }

  async function togglePlan(target: ManagedUser) {
    setAdminActionId(target.id);
    try {
      const updated = await api.adminChangePlan(target.id, target.plan === "FREE" ? "PREMIUM" : "FREE");
      setAdminUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
    } catch (err) {
      setAdminError(err instanceof ApiError ? err.message : "Échec du changement d'offre.");
    } finally {
      setAdminActionId(null);
    }
  }

  async function toggleRole(target: ManagedUser) {
    setAdminActionId(target.id);
    try {
      const updated = await api.adminChangeRole(target.id, target.role === "USER" ? "ADMIN" : "USER");
      setAdminUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
    } catch (err) {
      setAdminError(err instanceof ApiError ? err.message : "Échec du changement de rôle.");
    } finally {
      setAdminActionId(null);
    }
  }

  async function handleRevokeSessions(target: ManagedUser) {
    setAdminActionId(target.id);
    try {
      await api.adminRevokeSessions(target.id);
    } catch (err) {
      setAdminError(err instanceof ApiError ? err.message : "Échec de la révocation des sessions.");
    } finally {
      setAdminActionId(null);
    }
  }

  async function handleDelete(id: string) {
    setDeletingId(id);
    try {
      await api.deleteFile(id);
      setFiles((prev) => prev.filter((f) => f.id !== id));
      void refreshQuota();
    } catch {
      // on laisse le fichier dans la liste, l'utilisateur peut retenter
    } finally {
      setDeletingId(null);
    }
  }

  function copyShareLink(shareId: string, url: string) {
    setCopiedShareId(shareId);
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(url).catch(() => {});
    }
    setTimeout(() => setCopiedShareId((current) => (current === shareId ? null : current)), 2000);
  }

  async function createShareLink() {
    const pending = uploads.filter(
      (u) => u.status === "done" && u.fileId && !claimedFileIds.has(u.fileId),
    );
    if (pending.length === 0) return;

    setShareBusy(true);
    setShareError(null);
    try {
      const share = await api.createShare({
        fileIds: pending.map((u) => u.fileId!),
        expiresInHours: DEFAULT_SHARE_HOURS,
      });
      const url = `${window.location.origin}/d/${share.token}`;
      setSessionShares((prev) => [
        { id: share.id, url, fileNames: share.files.map((f) => f.fileName) },
        ...prev,
      ]);
      setClaimedFileIds((prev) => {
        const next = new Set(prev);
        for (const u of pending) next.add(u.fileId!);
        return next;
      });
    } catch (err) {
      setShareError(err instanceof ApiError ? err.message : "Échec de la création du lien.");
    } finally {
      setShareBusy(false);
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files?.length) handleFilesSelected(e.dataTransfer.files);
  }
  function onDragOver(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(true);
  }
  function onDragLeave() {
    setIsDragging(false);
  }

  const isSignin = screen === "signin";
  const isDrop = screen === "drop";
  const isFiles = screen === "files";
  const isAccount = screen === "account";
  const isAdmin = screen === "admin";
  const wide = !narrow;
  const isRoleAdmin = user?.role === "ADMIN";
  const navItems = isRoleAdmin ? [...NAV, { id: "admin" as Screen, label: "Admin" }] : NAV;

  const pendingShareCount = uploads.filter(
    (u) => u.status === "done" && u.fileId && !claimedFileIds.has(u.fileId),
  ).length;

  const level = live.level;
  const topInk = level > 0.82 ? "#ffffff" : "#16181c";
  const topMuted = level > 0.82 ? "#ffffff" : "#6b7178";
  const botInk = level > 0.2 ? "#ffffff" : "#16181c";

  const pctLabel = quota ? Math.round(quotaFraction * 100) + "%" : "—";
  const quotaLine = quota
    ? `${fmtBytes(quota.usedBytes)} sur ${fmtBytes(quota.limitBytes)}`
    : "Chargement du quota…";

  const headTitle = isDrop
    ? "Envoyer des fichiers"
    : isFiles
      ? "Mes fichiers"
      : isAdmin
        ? "Administration"
        : "Mon compte";
  const headSub = isDrop
    ? quota
      ? `${fmtBytes(quota.remainingBytes)} restants ce mois-ci`
      : "Chiffrement au repos, sans limite de taille annoncée côté design"
    : isFiles
      ? `${files.length} fichier${files.length > 1 ? "s" : ""}`
      : isAdmin
        ? adminStats
          ? `${adminStats.users.total} compte${adminStats.users.total > 1 ? "s" : ""}`
          : ""
        : user?.email ?? "";

  const initials = (user?.email ?? "?").slice(0, 2).toUpperCase();

  const sansFont = "var(--font-space-grotesk), system-ui, sans-serif";

  if (!authChecked) {
    return <div style={{ minHeight: "100vh", background: "#ffffff" }} />;
  }

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "#ffffff", overflow: "hidden" }}>
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
                <p style={{ margin: "16px 0 0", maxWidth: 290, font: `400 15px/1.55 ${sansFont}`, color: "#6b7178" }}>
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
              <form
                onSubmit={submitAuth}
                style={{ width: "100%", maxWidth: 330, animation: "rise .5s ease both" }}
              >
                <h1 style={{ margin: 0, font: `400 28px/1.15 ${sansFont}`, letterSpacing: "-.03em" }}>
                  {authMode === "login" ? "Welcome back" : "Créer un compte"}
                </h1>
                <div style={{ marginTop: 32, display: "flex", flexDirection: "column", gap: 16 }}>
                  <label style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <span style={{ font: `400 13px/1 ${sansFont}`, color: "#6b7178" }}>Email</span>
                    <input
                      type="email"
                      required
                      autoComplete="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="ftc-input"
                      style={{ padding: "14px 15px", borderRadius: 12, color: "#16181c", font: `400 15px/1 ${sansFont}` }}
                    />
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <span style={{ font: `400 13px/1 ${sansFont}`, color: "#6b7178" }}>Password</span>
                    <input
                      type="password"
                      required
                      minLength={authMode === "register" ? 12 : undefined}
                      autoComplete={authMode === "login" ? "current-password" : "new-password"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="ftc-input"
                      style={{ padding: "14px 15px", borderRadius: 12, color: "#16181c", font: `400 15px/1 ${sansFont}` }}
                    />
                  </label>
                  {authMode === "register" && (
                    <div style={{ font: `400 12.5px/1.4 ${sansFont}`, color: "#6b7178" }}>
                      Au moins 12 caractères.
                    </div>
                  )}
                </div>

                {authError && (
                  <div style={{ marginTop: 16, font: `400 13.5px/1.4 ${sansFont}`, color: "#d2493c" }}>
                    {authError}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={authBusy}
                  className="ftc-btn-primary"
                  style={{
                    marginTop: 26,
                    width: "100%",
                    padding: 16,
                    borderRadius: 99,
                    font: `500 15px/1 ${sansFont}`,
                    opacity: authBusy ? 0.7 : 1,
                  }}
                >
                  {authBusy ? "Un instant…" : authMode === "login" ? "Continue" : "Créer mon compte"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAuthMode((m) => (m === "login" ? "register" : "login"));
                    setAuthError(null);
                  }}
                  className="ftc-btn-text"
                  style={{ marginTop: 10, width: "100%", padding: 15, borderRadius: 99, font: `400 14px/1 ${sansFont}` }}
                >
                  {authMode === "login" ? "Pas de compte ? Créer un compte" : "Déjà un compte ? Se connecter"}
                </button>
              </form>
            </div>
          </div>
        )}

        {!isSignin && (
          <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
            {wide && (
              <div
                style={{
                  width: 216,
                  flex: "none",
                  padding: "32px 20px",
                  display: "flex",
                  flexDirection: "column",
                  background: "#fbfaf8",
                }}
              >
                <div style={{ font: `500 16px/1 ${sansFont}`, letterSpacing: "-.01em", paddingLeft: 10 }}>
                  File Moi Ça
                </div>
                <div style={{ marginTop: 32, display: "flex", flexDirection: "column", gap: 4 }}>
                  {navItems.map((n) => (
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
                    </button>
                  ))}
                </div>
                <span style={{ flex: 1 }} />
                <div style={{ padding: "0 12px" }}>
                  <div style={{ font: `400 13px/1 ${sansFont}`, color: "#6b7178" }}>{quotaLine}</div>
                  <div style={{ marginTop: 10, height: 5, borderRadius: 99, background: "rgba(22,24,28,.08)", overflow: "hidden" }}>
                    <div
                      style={{
                        height: "100%",
                        width: `${Math.min(100, Math.round(quotaFraction * 100))}%`,
                        background: "#5b4bff",
                        borderRadius: 99,
                      }}
                    />
                  </div>
                </div>
                <button
                  onClick={() => goToScreen("account")}
                  style={{
                    marginTop: 26,
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "0 12px",
                    border: "none",
                    background: "transparent",
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
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
                      flex: "none",
                    }}
                  >
                    {initials}
                  </div>
                  <div
                    style={{
                      font: `400 13px/1.3 ${sansFont}`,
                      color: "#6b7178",
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {user?.email}
                  </div>
                </button>
              </div>
            )}

            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap", padding: "32px 32px 22px" }}>
                <div style={{ font: `400 22px/1.15 ${sansFont}`, letterSpacing: "-.025em" }}>{headTitle}</div>
                <div style={{ font: `400 14px/1.4 ${sansFont}`, color: "#6b7178" }}>{headSub}</div>
              </div>

              {isDrop && (
                <div
                  style={{
                    flex: 1,
                    display: "flex",
                    flexDirection: narrow ? "column" : "row",
                    minHeight: 0,
                    minWidth: 0,
                    alignItems: "stretch",
                    gap: 0,
                  }}
                >
                  <div
                    onDrop={onDrop}
                    onDragOver={onDragOver}
                    onDragLeave={onDragLeave}
                    style={{
                      flex: "1 1 400px",
                      minWidth: 290,
                      position: "relative",
                      minHeight: 380,
                      overflow: "hidden",
                      background: isDragging ? "#e9e4da" : "#f1eee9",
                    }}
                  >
                    <canvas
                      ref={canvasRef}
                      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block" }}
                    />

                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      hidden
                      onChange={(e) => {
                        if (e.target.files) handleFilesSelected(e.target.files);
                        e.target.value = "";
                      }}
                    />
                    <input
                      ref={folderInputRef}
                      type="file"
                      multiple
                      hidden
                      // @ts-expect-error attribut non standard, supporté par les navigateurs Chromium/Firefox/Safari
                      webkitdirectory=""
                      onChange={(e) => {
                        if (e.target.files) handleFilesSelected(e.target.files);
                        e.target.value = "";
                      }}
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
                          <div style={{ marginTop: 8, font: `400 14px/1 ${sansFont}`, color: topMuted }}>
                            {isUploading ? "Envoi en cours" : "Quota utilisé"}
                          </div>
                        </div>
                      </div>
                      <span style={{ flex: 1 }} />

                      <div style={{ pointerEvents: "auto", alignSelf: "flex-start", maxWidth: 340 }}>
                        <div style={{ font: `300 30px/1.14 ${sansFont}`, letterSpacing: "-.03em", color: botInk }}>
                          {isDragging ? "Lâchez pour déposer." : "Drop your files here."}
                        </div>
                        <div style={{ display: "flex", gap: 10, marginTop: 22, flexWrap: "wrap" }}>
                          <button
                            onClick={() => fileInputRef.current?.click()}
                            className="ftc-btn-primary"
                            style={{ padding: "14px 22px", borderRadius: 99, font: `500 14.5px/1 ${sansFont}` }}
                          >
                            Choose files
                          </button>
                          <button
                            onClick={() => folderInputRef.current?.click()}
                            className="ftc-btn-secondary"
                            style={{ padding: "14px 20px", borderRadius: 99, font: `400 14.5px/1 ${sansFont}` }}
                          >
                            Add a folder
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div style={{ flex: "1 1 340px", minWidth: 290, display: "flex", flexDirection: "column", minHeight: 0, background: "#ffffff", padding: "0 26px 26px" }}>
                    <div style={{ padding: "6px 6px 14px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                      <div style={{ flex: 1, font: `400 14px/1 ${sansFont}`, color: "#6b7178" }}>
                        {uploads.length === 0 ? "Aucun envoi pour l'instant" : `${uploads.length} envoi${uploads.length > 1 ? "s" : ""} cette session`}
                      </div>
                      {uploads.length > 0 && (
                        <button
                          onClick={createShareLink}
                          disabled={pendingShareCount === 0 || shareBusy}
                          className="ftc-btn-primary"
                          style={{
                            padding: "9px 16px",
                            borderRadius: 99,
                            font: `500 13px/1 ${sansFont}`,
                            flex: "none",
                            opacity: pendingShareCount === 0 || shareBusy ? 0.5 : 1,
                          }}
                        >
                          {shareBusy
                            ? "Création…"
                            : pendingShareCount > 0
                              ? `Créer un lien de partage${pendingShareCount > 1 ? ` (${pendingShareCount})` : ""}`
                              : sessionShares.length > 0
                                ? "Lien de partage créé"
                                : "Créer un lien de partage"}
                        </button>
                      )}
                    </div>

                    {shareError && (
                      <div style={{ padding: "0 6px 12px", font: `400 13px/1.4 ${sansFont}`, color: "#d2493c" }}>
                        {shareError}
                      </div>
                    )}

                    {sessionShares.length > 0 && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "0 6px 16px" }}>
                        {sessionShares.map((share) => (
                          <div
                            key={share.id}
                            style={{ display: "flex", alignItems: "center", gap: 12, padding: 12, borderRadius: 14, background: "#f6f4f0" }}
                          >
                            <ShareQrCode url={share.url} size={44} />
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div
                                style={{
                                  font: `400 13px/1.5 var(--font-ibm-plex-mono), monospace`,
                                  color: "#16181c",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {share.url}
                              </div>
                              <div
                                style={{
                                  marginTop: 4,
                                  font: `400 12.5px/1.4 ${sansFont}`,
                                  color: "#6b7178",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {share.fileNames.length} fichier{share.fileNames.length > 1 ? "s" : ""} · {share.fileNames.join(", ")}
                              </div>
                            </div>
                            <button
                              onClick={() => copyShareLink(share.id, share.url)}
                              className="ftc-btn-secondary"
                              style={{ padding: "8px 14px", borderRadius: 99, font: `400 13px/1 ${sansFont}`, flex: "none" }}
                            >
                              {copiedShareId === share.id ? "Copié" : "Copier le lien"}
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    <div style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column", gap: 2, minHeight: 130 }}>
                      {uploads.map((u) => {
                        const tile = TILES[extFromName(u.name)] || FALLBACK_TILE;
                        const status =
                          u.status === "done"
                            ? "Envoyé"
                            : u.status === "error"
                              ? (u.error ?? "Erreur")
                              : `${Math.round(u.progress * 100)}%`;
                        const statusColor = u.status === "done" ? "#0b6b45" : u.status === "error" ? "#d2493c" : "#5b4bff";
                        return (
                          <div key={u.id} style={{ padding: "12px 6px", borderBottom: "1px solid rgba(22,24,28,.06)" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
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
                                {extFromName(u.name)}
                              </div>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ font: `400 15px/1.25 ${sansFont}`, color: "#16181c", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                  {u.name}
                                </div>
                                <div style={{ marginTop: 4, font: `400 13px/1.3 ${sansFont}`, color: "#6b7178" }}>
                                  {fmtBytes(u.sizeBytes)}
                                </div>
                              </div>
                              <div style={{ font: `400 13px/1 ${sansFont}`, color: statusColor, textAlign: "right", flex: "none", maxWidth: 140 }}>
                                {status}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}

              {isFiles && (
                <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "0 32px 32px" }}>
                  {filesError && (
                    <div style={{ marginBottom: 16, font: `400 14px/1.4 ${sansFont}`, color: "#d2493c" }}>{filesError}</div>
                  )}
                  {filesLoading && files.length === 0 && (
                    <div style={{ font: `400 14px/1.4 ${sansFont}`, color: "#6b7178" }}>Chargement…</div>
                  )}
                  {!filesLoading && files.length === 0 && !filesError && (
                    <div style={{ font: `400 14px/1.4 ${sansFont}`, color: "#6b7178" }}>
                      Aucun fichier déposé pour l&apos;instant.
                    </div>
                  )}
                  <div style={{ display: "flex", flexDirection: "column", gap: 2, maxWidth: 720 }}>
                    {files.map((f) => {
                      const tile = TILES[extFromName(f.originalName)] || FALLBACK_TILE;
                      return (
                        <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 6px" }}>
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
                            {extFromName(f.originalName)}
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ font: `400 15px/1.25 ${sansFont}`, color: "#16181c", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {f.originalName}
                            </div>
                            <div style={{ marginTop: 4, font: `400 13px/1.3 ${sansFont}`, color: "#6b7178" }}>
                              {fmtBytes(f.sizeBytes)} · {new Date(f.createdAt).toLocaleDateString("fr-FR")}
                            </div>
                          </div>
                          <button
                            onClick={() => handleDelete(f.id)}
                            disabled={deletingId === f.id}
                            className="ftc-btn-text"
                            style={{ padding: "8px 14px", borderRadius: 99, font: `400 13px/1 ${sansFont}`, flex: "none" }}
                          >
                            {deletingId === f.id ? "…" : "Supprimer"}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {isAccount && (
                <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "0 32px 32px" }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 420 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, font: `400 14px/1 ${sansFont}` }}>
                      <span style={{ color: "#6b7178" }}>Email</span>
                      <span style={{ color: "#3b4046" }}>{user?.email}</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, font: `400 14px/1 ${sansFont}` }}>
                      <span style={{ color: "#6b7178" }}>Offre</span>
                      <span style={{ color: "#3b4046" }}>{quota?.plan ?? "—"}</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, font: `400 14px/1 ${sansFont}` }}>
                      <span style={{ color: "#6b7178" }}>Utilisé ce mois-ci</span>
                      <span style={{ color: "#3b4046" }}>{quota ? fmtBytes(quota.usedBytes) : "—"}</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, font: `400 14px/1 ${sansFont}` }}>
                      <span style={{ color: "#6b7178" }}>Restant</span>
                      <span style={{ color: "#3b4046" }}>{quota ? fmtBytes(quota.remainingBytes) : "—"}</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, font: `400 14px/1 ${sansFont}` }}>
                      <span style={{ color: "#6b7178" }}>Période</span>
                      <span style={{ color: "#3b4046" }}>{quota?.period ?? "—"}</span>
                    </div>
                  </div>
                  <button
                    onClick={handleLogout}
                    className="ftc-btn-secondary"
                    style={{ marginTop: 26, padding: "13px 22px", borderRadius: 99, font: `500 14px/1 ${sansFont}` }}
                  >
                    Se déconnecter
                  </button>
                </div>
              )}

              {isAdmin && (
                <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "0 32px 32px" }}>
                  {adminError && (
                    <div style={{ marginBottom: 16, font: `400 14px/1.4 ${sansFont}`, color: "#d2493c" }}>
                      {adminError}
                    </div>
                  )}

                  {adminLoading && !adminStats && (
                    <div style={{ font: `400 14px/1.4 ${sansFont}`, color: "#6b7178" }}>Chargement…</div>
                  )}

                  {adminStats && (
                    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 26 }}>
                      {[
                        {
                          label: "Comptes",
                          value: String(adminStats.users.total),
                          sub: `${adminStats.users.free} gratuit${adminStats.users.free > 1 ? "s" : ""} · ${adminStats.users.premium} payant${adminStats.users.premium > 1 ? "s" : ""}`,
                        },
                        {
                          label: "Fichiers",
                          value: String(adminStats.files.total),
                          sub: fmtBytes(adminStats.files.totalBytes),
                        },
                        {
                          label: "Partages",
                          value: String(adminStats.shares.total),
                          sub: `${adminStats.shares.active} actif${adminStats.shares.active > 1 ? "s" : ""}`,
                        },
                      ].map((card) => (
                        <div
                          key={card.label}
                          style={{ flex: "1 1 160px", minWidth: 160, padding: 18, borderRadius: 16, background: "#f6f4f0" }}
                        >
                          <div style={{ font: `400 13px/1 ${sansFont}`, color: "#6b7178" }}>{card.label}</div>
                          <div style={{ marginTop: 8, font: `300 30px/1 ${sansFont}`, letterSpacing: "-.02em", color: "#16181c" }}>
                            {card.value}
                          </div>
                          <div style={{ marginTop: 6, font: `400 12.5px/1.3 ${sansFont}`, color: "#6b7178" }}>{card.sub}</div>
                        </div>
                      ))}
                    </div>
                  )}

                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    {adminUsers.map((u) => {
                      const busy = adminActionId === u.id;
                      const isSelf = u.id === user?.id;
                      return (
                        <div
                          key={u.id}
                          style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 6px", borderBottom: "1px solid rgba(22,24,28,.06)", flexWrap: "wrap" }}
                        >
                          <div style={{ flex: "1 1 220px", minWidth: 200 }}>
                            <div style={{ font: `400 15px/1.25 ${sansFont}`, color: "#16181c" }}>{u.email}</div>
                            <div style={{ marginTop: 4, font: `400 13px/1.3 ${sansFont}`, color: "#6b7178" }}>
                              {u.fileCount} fichier{u.fileCount > 1 ? "s" : ""} · {fmtBytes(u.usedBytesThisMonth)} / {fmtBytes(u.quotaBytes)} ce mois-ci
                            </div>
                          </div>

                          <div
                            style={{
                              padding: "5px 12px",
                              borderRadius: 99,
                              font: `400 12.5px/1 ${sansFont}`,
                              background: u.role === "ADMIN" ? "#ece9ff" : "#f6f4f0",
                              color: u.role === "ADMIN" ? "#3527cc" : "#3b4046",
                              flex: "none",
                            }}
                          >
                            {u.role}
                          </div>
                          <div
                            style={{
                              padding: "5px 12px",
                              borderRadius: 99,
                              font: `400 12.5px/1 ${sansFont}`,
                              background: u.plan === "PREMIUM" ? "#eafaf1" : "#f6f4f0",
                              color: u.plan === "PREMIUM" ? "#0b6b45" : "#3b4046",
                              flex: "none",
                            }}
                          >
                            {u.plan}
                          </div>

                          <div style={{ display: "flex", gap: 8, flex: "none" }}>
                            <button
                              onClick={() => togglePlan(u)}
                              disabled={busy}
                              className="ftc-btn-secondary"
                              style={{ padding: "8px 14px", borderRadius: 99, font: `400 13px/1 ${sansFont}` }}
                            >
                              {u.plan === "FREE" ? "Passer en PREMIUM" : "Repasser en FREE"}
                            </button>
                            <button
                              onClick={() => toggleRole(u)}
                              disabled={busy || isSelf}
                              title={isSelf ? "Impossible de retirer ses propres droits d'administration" : undefined}
                              className="ftc-btn-secondary"
                              style={{ padding: "8px 14px", borderRadius: 99, font: `400 13px/1 ${sansFont}`, opacity: isSelf ? 0.5 : 1 }}
                            >
                              {u.role === "USER" ? "Rendre admin" : "Retirer admin"}
                            </button>
                            <button
                              onClick={() => handleRevokeSessions(u)}
                              disabled={busy}
                              className="ftc-btn-text"
                              style={{ padding: "8px 14px", borderRadius: 99, font: `400 13px/1 ${sansFont}` }}
                            >
                              Révoquer les sessions
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
