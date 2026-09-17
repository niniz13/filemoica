"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  ApiError,
  api,
  type CurrentUser,
  type Share,
  type ShareStatus,
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

type Screen = "signin" | "drop" | "files" | "links" | "account" | "admin";
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
  /** Un lien révoqué reste affiché, barré : on montre que l'accès est coupé. */
  revoked: boolean;
  /** Marqués dans la liste : deux liens identiques à l'oeil seraient trompeurs. */
  singleUse: boolean;
  protege: boolean;
}

/** Durée de validité par défaut d'un lien de partage. */
const DEFAULT_SHARE_HOURS = 72;

const SANS_FONT = "var(--font-space-grotesk), system-ui, sans-serif";

/** Le serveur exige entre 6 et 128 caractères pour un mot de passe de lien. */
const SHARE_PASSWORD_MIN = 6;

/** Nombre de noms de fichiers cités avant de basculer sur un décompte. */
const NOMS_CITES = 2;

/**
 * Résume une liste de fichiers en une ligne lisible.
 *
 * Coller bout à bout dix-neuf noms produit une chaîne de plus de mille
 * caractères. Même tronquée à l'affichage, elle reste une seule ligne
 * insécable que le navigateur mesure entièrement : elle étire la colonne, qui
 * étire la page, et toute l'interface finit par sortir de l'écran.
 *
 * On cite donc les premiers noms et on compte le reste. La liste complète
 * n'est pas perdue pour autant : elle est portée par l'attribut `title`, donc
 * lisible au survol.
 */
function resumerFichiers(noms: string[]): string {
  if (noms.length <= NOMS_CITES) {
    return noms.join(", ");
  }

  const restants = noms.length - NOMS_CITES;

  return `${noms.slice(0, NOMS_CITES).join(", ")} et ${restants} autre${restants > 1 ? "s" : ""}`;
}

/** Durées proposées, bornées par le serveur : de 1 heure à 30 jours. */
const SHARE_DURATIONS: { hours: number; label: string }[] = [
  { hours: 1, label: "1 heure" },
  { hours: 24, label: "1 jour" },
  { hours: DEFAULT_SHARE_HOURS, label: "3 jours" },
  { hours: 24 * 7, label: "7 jours" },
  { hours: 24 * 30, label: "30 jours" },
];

interface ShareOptionsValue {
  singleUse: boolean;
  password: string;
  hours: number;
}

/**
 * Options du prochain lien, communes aux deux écrans de création.
 *
 * Extraites plutôt que recopiées : deux formulaires qui divergeraient un jour
 * seraient pires qu'un seul mal placé.
 */
function ShareOptions({
  value,
  onChange,
}: {
  value: ShareOptionsValue;
  onChange: (next: ShareOptionsValue) => void;
}) {
  const [visible, setVisible] = useState(false);
  const [copie, setCopie] = useState(false);

  const motDePasseTropCourt =
    value.password.length > 0 && value.password.length < SHARE_PASSWORD_MIN;

  function copier() {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(value.password).catch(() => {});
    }
    setCopie(true);
    setTimeout(() => setCopie(false), 2000);
  }

  return (
    // `1 1 240px` et non `none` : en `none`, ce bloc impose sa largeur naturelle
    // — l'input et ses deux boutons font près de 490 px — à un panneau qui peut
    // descendre à 290. Il débordait alors hors de l'écran.
    <div style={{ display: "flex", flexDirection: "column", gap: 10, flex: "1 1 240px", minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            cursor: "pointer",
            font: `400 13px/1.3 ${SANS_FONT}`,
            color: "#6b7178",
          }}
          title="Le lien se consume une fois tous les fichiers téléchargés, et ils sont effacés du serveur."
        >
          <input
            type="checkbox"
            checked={value.singleUse}
            onChange={(e) => onChange({ ...value, singleUse: e.target.checked })}
            style={{ accentColor: ACCENT, width: 15, height: 15, cursor: "pointer" }}
          />
          Lien à usage unique
        </label>

        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            font: `400 13px/1.3 ${SANS_FONT}`,
            color: "#6b7178",
          }}
        >
          Expire dans
          <select
            value={value.hours}
            onChange={(e) => onChange({ ...value, hours: Number(e.target.value) })}
            style={{
              font: `400 13px/1.3 ${SANS_FONT}`,
              color: "#16181c",
              padding: "6px 8px",
              borderRadius: 10,
              border: "1px solid #dcd9d4",
              background: "#ffffff",
              cursor: "pointer",
            }}
          >
            {SHARE_DURATIONS.map((d) => (
              <option key={d.hours} value={d.hours}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <label
          htmlFor="mot-de-passe-du-lien"
          style={{ font: `400 13px/1.3 ${SANS_FONT}`, color: "#6b7178" }}
        >
          Mot de passe <span style={{ opacity: 0.7 }}>(facultatif)</span>
        </label>

        {/* `wrap` : « Voir » et « Copier » descendent sous le champ plutôt que
            de l'écraser quand la colonne est étroite. */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <input
            id="mot-de-passe-du-lien"
            type={visible ? "text" : "password"}
            value={value.password}
            onChange={(e) => onChange({ ...value, password: e.target.value })}
            placeholder="Laisser vide pour un lien sans mot de passe"
            autoComplete="new-password"
            maxLength={128}
            style={{
              font: `400 13.5px/1.3 ${SANS_FONT}`,
              color: "#16181c",
              padding: "9px 12px",
              borderRadius: 12,
              border: `1px solid ${motDePasseTropCourt ? "#d2493c" : "#dcd9d4"}`,
              background: "#ffffff",
              // Base de 180 px : en dessous, ce sont les boutons qui passent à
              // la ligne, plutôt que le champ qui devient inutilisable.
              flex: "1 1 180px",
              minWidth: 0,
              maxWidth: 340,
            }}
          />

          {/* Voir ce qu'on tape évite de protéger un lien avec une faute de
              frappe : le mot de passe ne se réaffiche jamais ensuite. */}
          <button
            type="button"
            onClick={() => setVisible((v) => !v)}
            disabled={value.password.length === 0}
            className="ftc-btn-secondary"
            style={{
              padding: "8px 12px",
              borderRadius: 99,
              font: `400 13px/1 ${SANS_FONT}`,
              flex: "none",
              opacity: value.password.length === 0 ? 0.45 : 1,
            }}
          >
            {visible ? "Masquer" : "Voir"}
          </button>

          {/* Il faut bien le transmettre au destinataire — par un autre canal
              que le lien, sans quoi la protection ne sert à rien. */}
          <button
            type="button"
            onClick={copier}
            disabled={value.password.length === 0}
            className="ftc-btn-secondary"
            style={{
              padding: "8px 12px",
              borderRadius: 99,
              font: `400 13px/1 ${SANS_FONT}`,
              flex: "none",
              opacity: value.password.length === 0 ? 0.45 : 1,
            }}
          >
            {copie ? "Copié" : "Copier"}
          </button>
        </div>

        {motDePasseTropCourt && (
          <span style={{ font: `400 12.5px/1.3 ${SANS_FONT}`, color: "#d2493c" }}>
            Au moins {SHARE_PASSWORD_MIN} caractères.
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Apparence de chaque état d'un lien.
 *
 * `CONSUMED` et `REVOKED` sont distingués à dessein : le premier a servi comme
 * prévu, le second a été coupé. Les confondre dirait au déposant qu'il a
 * révoqué un lien qu'il n'a jamais touché.
 */
const SHARE_STATUS: Record<
  ShareStatus,
  { libelle: string; fond: string; texte: string }
> = {
  ACTIVE: { libelle: "Actif", fond: "#e6f4ea", texte: "#1e7a3c" },
  CONSUMED: { libelle: "Consommé", fond: "#ece9ff", texte: ACCENT },
  EXPIRED: { libelle: "Expiré", fond: "#f0efed", texte: "#6b7178" },
  REVOKED: { libelle: "Révoqué", fond: "#fbe9e7", texte: "#d2493c" },
};

const NAV: { id: Screen; label: string }[] = [
  { id: "drop", label: "Envoyer" },
  { id: "files", label: "Mes fichiers" },
  { id: "links", label: "Mes liens" },
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
  /**
   * Adresse qui vient de s'inscrire, en attente de confirmation.
   *
   * Tant qu'elle est renseignée, on affiche l'invitation à consulter sa boîte
   * plutôt que le formulaire : la prochaine étape est dans le courriel, pas
   * sur cet écran.
   */
  const [inscriptionFaite, setInscriptionFaite] = useState<string | null>(null);
  const [renvoiFait, setRenvoiFait] = useState(false);
  /**
   * Défi de double authentification en cours.
   *
   * Tant qu'il est là, on demande le code plutôt que les identifiants : ceux-ci
   * ont déjà été acceptés, les redemander serait absurde.
   */
  const [defiMfa, setDefiMfa] = useState<{ id: string; email: string } | null>(
    null,
  );
  const [codeMfa, setCodeMfa] = useState("");
  /**
   * Réglage du second facteur depuis la page « Compte ».
   *
   * Le mot de passe est ressaisi ici parce que le serveur l'exige : armer ou
   * désarmer un facteur d'authentification ne doit pas tenir à la seule
   * possession d'une session.
   */
  const [mdpMfa, setMdpMfa] = useState("");
  const [mfaBusy, setMfaBusy] = useState(false);
  const [mfaError, setMfaError] = useState<string | null>(null);
  const [mfaMessage, setMfaMessage] = useState<string | null>(null);

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
  /** Nombre de sessions coupées, affiché quelques secondes après l'action. */
  const [sessionsCoupees, setSessionsCoupees] = useState<Record<string, number>>({});

  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [sessionShares, setSessionShares] = useState<SessionShare[]>([]);
  const [claimedFileIds, setClaimedFileIds] = useState<Set<string>>(new Set());
  const [shareBusy, setShareBusy] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [copiedShareId, setCopiedShareId] = useState<string | null>(null);
  const [revokingShareId, setRevokingShareId] = useState<string | null>(null);
  /**
   * Liens créés depuis la liste « mes fichiers », indexés par fichier.
   *
   * Séparé de `sessionShares`, qui ne couvre que les dépôts de la session en
   * cours : ici on repartage un fichier déjà déposé, éventuellement il y a
   * plusieurs jours.
   */
  const [fileShareLinks, setFileShareLinks] = useState<
    Record<string, { id: string; url: string; revoked: boolean; singleUse: boolean; protege: boolean }>
  >({});
  const [sharingFileId, setSharingFileId] = useState<string | null>(null);
  const [fileShareError, setFileShareError] = useState<string | null>(null);
  /**
   * Options appliquées au **prochain** lien créé, quel que soit l'écran.
   *
   * Un seul état pour les deux points de création : le déposant ne doit pas
   * avoir à se demander si l'option qu'il vient de cocher vaut ici ou là.
   */
  const [shareOptions, setShareOptions] = useState<ShareOptionsValue>({
    singleUse: false,
    password: "",
    hours: DEFAULT_SHARE_HOURS,
  });
  const singleUse = shareOptions.singleUse;
  /** Un mot de passe trop court serait refusé par le serveur : on n'envoie pas. */
  const optionsValides =
    shareOptions.password.length === 0 ||
    shareOptions.password.length >= SHARE_PASSWORD_MIN;
  const [shares, setShares] = useState<Share[]>([]);
  const [sharesLoading, setSharesLoading] = useState(false);
  const [sharesError, setSharesError] = useState<string | null>(null);
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
      const fresh = await api.listFiles();
      setFiles(fresh);
      setFilesError(null);

      // Un fichier effacé par un lien à usage unique emporte son lien avec lui.
      // Sans ce nettoyage, on proposerait de révoquer — ou de recréer — un lien
      // vers un fichier qui n'existe plus.
      const encorePresents = new Set(fresh.map((f) => f.id));
      setFileShareLinks((prev) => {
        const next = Object.fromEntries(
          Object.entries(prev).filter(([fileId]) => encorePresents.has(fileId)),
        );
        return Object.keys(next).length === Object.keys(prev).length ? prev : next;
      });
    } catch (err) {
      setFilesError(err instanceof ApiError ? err.message : "Impossible de charger les fichiers.");
    } finally {
      setFilesLoading(false);
    }
  }, []);

  const refreshShares = useCallback(async () => {
    setSharesLoading(true);
    try {
      setShares(await api.listShares());
      setSharesError(null);
    } catch (err) {
      setSharesError(err instanceof ApiError ? err.message : "Impossible de charger les liens.");
    } finally {
      setSharesLoading(false);
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

        // On n'enchaîne plus sur la connexion : elle échouerait, l'adresse
        // n'étant pas encore confirmée. Afficher ce refus juste après une
        // inscription réussie donnait l'impression que l'inscription avait raté.
        setInscriptionFaite(email);
        setPassword("");
        setEmail("");
        return;
      }

      // Deux issues, selon le réglage du compte : soit la session est ouverte
      // ici même, soit un code est parti par courriel et il reste une étape.
      const issue = await api.login(email, password);

      if (issue.mfaRequired) {
        setDefiMfa({ id: issue.challengeId, email });
        setPassword("");
        setCodeMfa("");
        return;
      }

      setUser({ ...issue.user, mfaEnabled: false });
      setPassword("");
      setScreen("drop");
      void refreshQuota();
      void refreshFiles();
    } catch (err) {
      setAuthError(err instanceof ApiError ? err.message : "Une erreur est survenue.");
    } finally {
      setAuthBusy(false);
    }
  }

  /**
   * Valide le code reçu par courriel et ouvre la session.
   *
   * En cas d'échec, on reste sur cet écran : le défi tolère cinq essais, et
   * renvoyer l'utilisateur au formulaire d'identifiants lui en ferait perdre
   * un pour rien.
   */
  async function validerLeCode(e: FormEvent) {
    e.preventDefault();
    if (!defiMfa) return;

    setAuthBusy(true);
    setAuthError(null);
    try {
      const connecte = await api.verifyMfa(defiMfa.id, codeMfa);
      // Le code a été demandé : le second facteur est forcément armé.
      setUser({ ...connecte, mfaEnabled: true });
      setDefiMfa(null);
      setCodeMfa("");
      setScreen("drop");
      void refreshQuota();
      void refreshFiles();
    } catch (err) {
      setAuthError(
        err instanceof ApiError ? err.message : "Code incorrect ou expiré.",
      );
      setCodeMfa("");
    } finally {
      setAuthBusy(false);
    }
  }

  /**
   * Arme ou désarme le second facteur sur son propre compte.
   *
   * Le mot de passe accompagne la demande : sans lui, le serveur refuse. Une
   * session volée ne doit pas suffire à couper la protection.
   */
  async function basculerMfa(enabled: boolean) {
    setMfaBusy(true);
    setMfaError(null);
    setMfaMessage(null);
    try {
      const { mfaEnabled } = await api.setMfa(enabled, mdpMfa);
      setUser((prev) => (prev ? { ...prev, mfaEnabled } : prev));
      setMdpMfa("");
      setMfaMessage(
        mfaEnabled
          ? "Double authentification activée. Un code vous sera demandé à chaque connexion."
          : "Double authentification désactivée.",
      );
    } catch (err) {
      setMfaError(
        err instanceof ApiError ? err.message : "Le réglage n'a pas pu être enregistré.",
      );
    } finally {
      setMfaBusy(false);
    }
  }

  /**
   * Abandonne la tentative en cours et revient aux identifiants.
   *
   * Le défi reste ouvert côté serveur, mais il sera invalidé à la prochaine
   * connexion : rien ne traîne.
   */
  function abandonnerLeCode() {
    setDefiMfa(null);
    setCodeMfa("");
    setAuthError(null);
  }

  /**
   * Redemande un lien de confirmation.
   *
   * Le bouton reste désactivé ensuite : le serveur répond toujours `204`, même
   * pour une adresse inconnue, donc rien ne distingue un succès d'un échec.
   * Laisser recliquer donnerait l'illusion d'un retour qu'on n'a pas.
   */
  async function renvoyerLaConfirmation() {
    if (!inscriptionFaite) return;
    setRenvoiFait(true);
    try {
      await api.resendVerification(inscriptionFaite);
    } catch {
      // Sans conséquence : la personne peut recharger la page et réessayer.
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
    // L'écran « Envoyer » est un plan de travail, pas un historique : ce qu'on
    // y voit, c'est l'envoi en cours. En sortir le referme.
    //
    // Rien n'est perdu — les fichiers déposés sont sur le serveur et se
    // retrouvent dans « Mes fichiers », d'où on peut créer un nouveau lien.
    if (screen === "drop" && next !== "drop") {
      setUploads([]);
      setSessionShares([]);
      setClaimedFileIds(new Set());
      setShareError(null);
    }

    setScreen(next);
    if (next === "admin") void refreshAdmin();
    if (next === "links") void refreshShares();
    // Un lien à usage unique consommé efface ses fichiers côté serveur, sans
    // que cette page en soit informée. On relit donc la liste en y entrant,
    // plutôt que d'afficher des fichiers qui n'existent plus.
    if (next === "files") {
      void refreshFiles();
      void refreshQuota();
    }
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
      // Le serveur renvoie le nombre de sessions coupées, et il était jeté :
      // on cliquait sans qu'il ne se passe rien de visible. Sur une action
      // aussi brutale, ne rien montrer invite à recliquer.
      const { revoked } = await api.adminRevokeSessions(target.id);
      setSessionsCoupees((prev) => ({ ...prev, [target.id]: revoked }));
      setTimeout(
        () =>
          setSessionsCoupees((prev) => {
            const reste = { ...prev };
            delete reste[target.id];
            return reste;
          }),
        4000,
      );
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

  /**
   * Coupe l'accès à un lien déjà transmis.
   *
   * Le lien reste affiché, barré : le déposant doit voir que c'est bien *ce*
   * lien qui est mort, pas qu'il a disparu. Le faire s'évanouir laisserait un
   * doute sur ce qui a été révoqué.
   */
  async function handleRevokeShare(shareId: string) {
    setRevokingShareId(shareId);
    setShareError(null);
    try {
      await api.revokeShare(shareId);
      setSessionShares((prev) =>
        prev.map((s) => (s.id === shareId ? { ...s, revoked: true } : s)),
      );
      setShares((prev) =>
        prev.map((s) => (s.id === shareId ? { ...s, status: "REVOKED" as const } : s)),
      );
      // Le même lien peut avoir été créé depuis la liste des fichiers.
      setFileShareLinks((prev) => {
        const entry = Object.entries(prev).find(([, v]) => v.id === shareId);
        if (!entry) return prev;
        return { ...prev, [entry[0]]: { ...entry[1], revoked: true } };
      });
    } catch (err) {
      setShareError(
        err instanceof ApiError ? err.message : "Échec de la révocation du lien.",
      );
    } finally {
      setRevokingShareId(null);
    }
  }

  /**
   * Crée un lien pour un fichier déjà déposé.
   *
   * Sans cela, un fichier dont le lien a été révoqué serait définitivement
   * bloqué : plus aucun moyen de le retransmettre, la seule action restante
   * étant de le supprimer. Un fichier déposé lors d'une session précédente
   * n'était pas partageable non plus.
   */
  async function createLinkForFile(fileId: string) {
    setSharingFileId(fileId);
    setFileShareError(null);
    try {
      const share = await api.createShare({
        fileIds: [fileId],
        expiresInHours: shareOptions.hours,
        burnAfterDownload: shareOptions.singleUse,
        ...(shareOptions.password ? { password: shareOptions.password } : {}),
      });
      setFileShareLinks((prev) => ({
        ...prev,
        [fileId]: {
          id: share.id,
          url: `${window.location.origin}/d/${share.token}`,
          revoked: false,
          singleUse,
          protege: Boolean(shareOptions.password),
        },
      }));
    } catch (err) {
      setFileShareError(
        err instanceof ApiError ? err.message : "Échec de la création du lien.",
      );
    } finally {
      setSharingFileId(null);
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
        expiresInHours: shareOptions.hours,
        burnAfterDownload: shareOptions.singleUse,
        ...(shareOptions.password ? { password: shareOptions.password } : {}),
      });
      const url = `${window.location.origin}/d/${share.token}`;
      setSessionShares((prev) => [
        { id: share.id, url, fileNames: share.files.map((f) => f.fileName), revoked: false, singleUse, protege: Boolean(shareOptions.password) },
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
  const isLinks = screen === "links";
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
              {defiMfa ? (
                <form
                  onSubmit={validerLeCode}
                  style={{ width: "100%", maxWidth: 360, animation: "rise .5s ease both" }}
                >
                  <h1 style={{ margin: 0, font: `400 28px/1.15 ${sansFont}`, letterSpacing: "-.03em" }}>
                    Code de connexion
                  </h1>
                  <p style={{ margin: "14px 0 0", font: `400 14px/1.6 ${sansFont}`, color: "#3b4046" }}>
                    Un code à six chiffres vient d&apos;être envoyé à{" "}
                    <strong>{defiMfa.email}</strong>.
                  </p>

                  <label style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 22 }}>
                    <span style={{ font: `400 13px/1 ${sansFont}`, color: "#6b7178" }}>Code</span>
                    <input
                      value={codeMfa}
                      // Le clavier numérique s'ouvre seul sur téléphone, et le
                      // gestionnaire de mots de passe propose le code reçu.
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      autoFocus
                      // On retire tout ce qui n'est pas un chiffre : un code
                      // collé depuis un courriel traîne souvent une espace.
                      onChange={(e) => setCodeMfa(e.target.value.replace(/\D/g, ""))}
                      placeholder="000000"
                      style={{
                        font: `400 24px/1.2 var(--font-ibm-plex-mono), monospace`,
                        letterSpacing: "8px",
                        textAlign: "center",
                        color: "#16181c",
                        padding: "12px 14px",
                        borderRadius: 12,
                        border: "1px solid #dcd9d4",
                        background: "#ffffff",
                      }}
                    />
                  </label>

                  {authError && (
                    <div style={{ marginTop: 12, font: `400 13px/1.4 ${sansFont}`, color: "#d2493c" }}>
                      {authError}
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={authBusy || codeMfa.length !== 6}
                    className="ftc-btn-primary"
                    style={{
                      width: "100%",
                      marginTop: 18,
                      padding: "12px 18px",
                      borderRadius: 99,
                      font: `500 14px/1 ${sansFont}`,
                      opacity: authBusy || codeMfa.length !== 6 ? 0.5 : 1,
                    }}
                  >
                    {authBusy ? "Vérification…" : "Se connecter"}
                  </button>

                  <p style={{ margin: "14px 0 0", font: `400 12.5px/1.5 ${sansFont}`, color: "#6b7178" }}>
                    Le code expire dans 10 minutes et ne sert qu&apos;une fois.
                    Après cinq essais, il faut reprendre la connexion.
                  </p>

                  <button
                    type="button"
                    onClick={abandonnerLeCode}
                    className="ftc-btn-text"
                    style={{
                      marginTop: 10,
                      padding: "8px 0",
                      font: `400 13px/1 ${sansFont}`,
                      background: "none",
                    }}
                  >
                    Revenir à la connexion
                  </button>
                </form>
              ) : inscriptionFaite ? (
                <div style={{ width: "100%", maxWidth: 360, animation: "rise .5s ease both" }}>
                  <h1 style={{ margin: 0, font: `400 28px/1.15 ${sansFont}`, letterSpacing: "-.03em" }}>
                    Compte créé
                  </h1>
                  <p style={{ margin: "16px 0 0", font: `400 14px/1.6 ${sansFont}`, color: "#3b4046" }}>
                    Un courriel vient d&apos;être envoyé à <strong>{inscriptionFaite}</strong>.
                    Ouvrez le lien qu&apos;il contient pour confirmer votre adresse,
                    puis connectez-vous.
                  </p>
                  <p style={{ margin: "12px 0 0", font: `400 13px/1.5 ${sansFont}`, color: "#6b7178" }}>
                    Le lien expire dans 24 heures. Pensez à regarder dans les
                    courriers indésirables.
                  </p>

                  <div style={{ display: "flex", gap: 10, marginTop: 24, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      onClick={() => {
                        setInscriptionFaite(null);
                        setRenvoiFait(false);
                        setAuthMode("login");
                      }}
                      className="ftc-btn-primary"
                      style={{ padding: "11px 18px", borderRadius: 99, font: `500 14px/1 ${sansFont}` }}
                    >
                      Aller à la connexion
                    </button>
                    <button
                      type="button"
                      onClick={renvoyerLaConfirmation}
                      disabled={renvoiFait}
                      className="ftc-btn-secondary"
                      style={{
                        padding: "11px 18px",
                        borderRadius: 99,
                        font: `400 14px/1 ${sansFont}`,
                        opacity: renvoiFait ? 0.5 : 1,
                      }}
                    >
                      {renvoiFait ? "Courriel renvoyé" : "Renvoyer le courriel"}
                    </button>
                  </div>
                </div>
              ) : (
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
              )}
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

                  {/* `overflowX: hidden` est un filet de sécurité, pas la
                      solution : tout ce qui est à l'intérieur sait déjà se
                      tronquer. Il garantit qu'un contenu inattendu sera coupé
                      ici plutôt que de pousser toute la page hors de l'écran. */}
                  <div style={{ flex: "1 1 340px", minWidth: 290, display: "flex", flexDirection: "column", minHeight: 0, overflowX: "hidden", background: "#ffffff", padding: "0 26px 26px" }}>
                    <div style={{ padding: "6px 6px 14px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                      <div style={{ flex: 1, font: `400 14px/1 ${sansFont}`, color: "#6b7178" }}>
                        {uploads.length === 0 ? "Aucun envoi pour l'instant" : `${uploads.length} envoi${uploads.length > 1 ? "s" : ""} cette session`}
                      </div>
                      {uploads.length > 0 && pendingShareCount > 0 && (
                        <ShareOptions value={shareOptions} onChange={setShareOptions} />
                      )}
                      {uploads.length > 0 && (
                        <button
                          onClick={createShareLink}
                          disabled={pendingShareCount === 0 || shareBusy || !optionsValides}
                          className="ftc-btn-primary"
                          style={{
                            padding: "9px 16px",
                            borderRadius: 99,
                            // `1.25` et non `1` : l'intitulé peut atteindre
                            // « Créer un lien à usage unique (3) », qui passe
                            // sur deux lignes dans une colonne étroite.
                            font: `500 13px/1.25 ${sansFont}`,
                            flex: "none",
                            // Sans ce plafond, le bouton impose sa largeur
                            // naturelle et pousse la ligne hors de l'écran.
                            maxWidth: "100%",
                            opacity: pendingShareCount === 0 || shareBusy || !optionsValides ? 0.5 : 1,
                          }}
                        >
                          {shareBusy
                            ? "Création…"
                            : pendingShareCount > 0
                              ? `Créer un lien${singleUse ? " à usage unique" : " de partage"}${pendingShareCount > 1 ? ` (${pendingShareCount})` : ""}`
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
                      <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "0 6px 16px", minWidth: 0 }}>
                        {sessionShares.map((share) => (
                          <div
                            key={share.id}
                            // `wrap` : le QR code et les deux boutons ne se
                            // compriment pas (`flex: none`). Sans autorisation
                            // de passer à la ligne, leur largeur cumulée dépasse
                            // celle du panneau dès que la fenêtre se resserre,
                            // et le contenu sort de l'écran.
                            style={{ display: "flex", alignItems: "center", gap: 12, padding: 12, borderRadius: 14, background: "#f6f4f0", flexWrap: "wrap" }}
                          >
                            <ShareQrCode url={share.url} size={44} />
                            {/* `1 1 180px` plutôt que `1` : en dessous de cette
                                largeur, le bloc déclenche le retour à la ligne
                                des boutons au lieu de les écraser. */}
                            <div style={{ flex: "1 1 180px", minWidth: 0 }}>
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
                                // La liste complète reste consultable au survol.
                                title={share.revoked ? undefined : share.fileNames.join(", ")}
                                style={{
                                  marginTop: 4,
                                  font: `400 12.5px/1.4 ${sansFont}`,
                                  color: share.revoked ? "#d2493c" : "#6b7178",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {share.revoked
                                  ? "Lien révoqué — l'accès est coupé"
                                  : `${share.singleUse ? "Usage unique · " : ""}${share.protege ? "Protégé · " : ""}${share.fileNames.length} fichier${share.fileNames.length > 1 ? "s" : ""} · ${resumerFichiers(share.fileNames)}`}
                              </div>
                            </div>
                            {/* Les deux boutons dans un même bloc : ils passent
                                à la ligne ensemble, jamais l'un sans l'autre. */}
                            {!share.revoked && (
                              <div style={{ display: "flex", gap: 8, flex: "none", marginLeft: "auto" }}>
                                <button
                                  onClick={() => copyShareLink(share.id, share.url)}
                                  className="ftc-btn-secondary"
                                  style={{ padding: "8px 14px", borderRadius: 99, font: `400 13px/1 ${sansFont}`, flex: "none", whiteSpace: "nowrap" }}
                                >
                                  {copiedShareId === share.id ? "Copié" : "Copier le lien"}
                                </button>
                                <button
                                  onClick={() => handleRevokeShare(share.id)}
                                  disabled={revokingShareId === share.id}
                                  className="ftc-btn-secondary"
                                  style={{
                                    padding: "8px 14px",
                                    borderRadius: 99,
                                    font: `400 13px/1 ${sansFont}`,
                                    flex: "none",
                                    whiteSpace: "nowrap",
                                    color: "#d2493c",
                                    opacity: revokingShareId === share.id ? 0.5 : 1,
                                  }}
                                >
                                  {revokingShareId === share.id ? "Révocation…" : "Révoquer"}
                                </button>
                              </div>
                            )}
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
                  {fileShareError && (
                    <div style={{ marginBottom: 16, font: `400 14px/1.4 ${sansFont}`, color: "#d2493c" }}>{fileShareError}</div>
                  )}
                  {files.length > 0 && (
                    <div style={{ marginBottom: 14, padding: "0 6px" }}>
                      <ShareOptions value={shareOptions} onChange={setShareOptions} />
                    </div>
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
                      const link = fileShareLinks[f.id];
                      return (
                        <div key={f.id} style={{ display: "flex", flexDirection: "column", padding: "12px 6px" }}>
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
                          {!link && (
                            <button
                              onClick={() => createLinkForFile(f.id)}
                              disabled={sharingFileId === f.id || !optionsValides}
                              className="ftc-btn-secondary"
                              style={{ padding: "8px 14px", borderRadius: 99, font: `400 13px/1 ${sansFont}`, flex: "none" }}
                            >
                              {sharingFileId === f.id ? "Création…" : singleUse ? "Créer un lien à usage unique" : "Créer un lien"}
                            </button>
                          )}
                          <button
                            onClick={() => handleDelete(f.id)}
                            disabled={deletingId === f.id}
                            className="ftc-btn-text"
                            style={{ padding: "8px 14px", borderRadius: 99, font: `400 13px/1 ${sansFont}`, flex: "none" }}
                          >
                            {deletingId === f.id ? "…" : "Supprimer"}
                          </button>
                        </div>

                        {link && (
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 12,
                              marginTop: 10,
                              marginLeft: 50,
                              padding: 12,
                              borderRadius: 14,
                              background: "#f6f4f0",
                            }}
                          >
                            <div
                              style={{
                                flex: 1,
                                minWidth: 0,
                                font: `400 13px/1.5 var(--font-ibm-plex-mono), monospace`,
                                color: link.revoked ? "#d2493c" : "#16181c",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {link.revoked ? "Lien révoqué — l'accès est coupé" : link.url}
                            </div>
                            {!link.revoked && link.protege && (
                              <span
                                style={{
                                  flex: "none",
                                  padding: "4px 10px",
                                  borderRadius: 99,
                                  background: "#f0efed",
                                  color: "#6b7178",
                                  font: `500 12px/1.3 ${sansFont}`,
                                }}
                              >
                                Protégé
                              </span>
                            )}
                            {!link.revoked && link.singleUse && (
                              <span
                                style={{
                                  flex: "none",
                                  padding: "4px 10px",
                                  borderRadius: 99,
                                  background: "#ece9ff",
                                  color: ACCENT,
                                  font: `500 12px/1.3 ${sansFont}`,
                                }}
                              >
                                Usage unique
                              </span>
                            )}
                            {!link.revoked && (
                              <button
                                onClick={() => copyShareLink(link.id, link.url)}
                                className="ftc-btn-secondary"
                                style={{ padding: "8px 14px", borderRadius: 99, font: `400 13px/1 ${sansFont}`, flex: "none" }}
                              >
                                {copiedShareId === link.id ? "Copié" : "Copier le lien"}
                              </button>
                            )}
                            {!link.revoked && (
                              <button
                                onClick={() => handleRevokeShare(link.id)}
                                disabled={revokingShareId === link.id}
                                className="ftc-btn-secondary"
                                style={{
                                  padding: "8px 14px",
                                  borderRadius: 99,
                                  font: `400 13px/1 ${sansFont}`,
                                  flex: "none",
                                  color: "#d2493c",
                                  opacity: revokingShareId === link.id ? 0.5 : 1,
                                }}
                              >
                                {revokingShareId === link.id ? "Révocation…" : "Révoquer"}
                              </button>
                            )}
                            {link.revoked && (
                              <button
                                onClick={() => createLinkForFile(f.id)}
                                disabled={sharingFileId === f.id || !optionsValides}
                                className="ftc-btn-secondary"
                                style={{ padding: "8px 14px", borderRadius: 99, font: `400 13px/1 ${sansFont}`, flex: "none" }}
                              >
                                {sharingFileId === f.id ? "Création…" : singleUse ? "Nouveau lien à usage unique" : "Créer un nouveau lien"}
                              </button>
                            )}
                          </div>
                        )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {isLinks && (
                <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "0 32px 32px" }}>
                  {sharesError && (
                    <div style={{ marginBottom: 16, font: `400 14px/1.4 ${sansFont}`, color: "#d2493c" }}>{sharesError}</div>
                  )}

                  <p style={{ margin: "0 0 18px", maxWidth: 720, font: `400 13.5px/1.5 ${sansFont}`, color: "#6b7178" }}>
                    Les liens que vous avez créés. L&apos;adresse n&apos;est pas
                    rappelée&nbsp;: le serveur n&apos;en conserve qu&apos;une empreinte,
                    jamais le lien lui-même. Pour retransmettre un fichier, créez-en un
                    nouveau depuis «&nbsp;Mes fichiers&nbsp;».
                  </p>

                  {sharesLoading && shares.length === 0 && (
                    <div style={{ font: `400 14px/1.4 ${sansFont}`, color: "#6b7178" }}>Chargement…</div>
                  )}
                  {!sharesLoading && shares.length === 0 && !sharesError && (
                    <div style={{ font: `400 14px/1.4 ${sansFont}`, color: "#6b7178" }}>
                      Aucun lien créé pour l&apos;instant.
                    </div>
                  )}

                  <div style={{ display: "flex", flexDirection: "column", gap: 2, maxWidth: 720 }}>
                    {shares.map((s) => {
                      // Supprimer un fichier ne touche pas à ses liens : le
                      // partage reste « actif » côté serveur, mais n'a plus rien
                      // à servir. L'afficher comme actif serait mentir — et
                      // proposer de le révoquer, absurde.
                      const sansObjet = s.status === "ACTIVE" && s.files.length === 0;
                      const etat = sansObjet
                        ? { libelle: "Sans objet", fond: "#f0efed", texte: "#6b7178" }
                        : SHARE_STATUS[s.status];
                      return (
                        <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 6px" }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div
                              title={s.files.map((f) => f.fileName).join(", ")}
                              style={{
                                font: `400 15px/1.25 ${sansFont}`,
                                color: "#16181c",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {s.files.length > 0
                                ? resumerFichiers(s.files.map((f) => f.fileName))
                                : "Plus aucun fichier"}
                            </div>
                            <div style={{ marginTop: 4, font: `400 13px/1.3 ${sansFont}`, color: "#6b7178" }}>
                              {s.singleUse ? "Usage unique · " : ""}
                              {s.protectedByPassword ? "Protégé par mot de passe · " : ""}
                              Expire le {new Date(s.expiresAt).toLocaleString("fr-FR")}
                            </div>
                          </div>

                          <span
                            style={{
                              flex: "none",
                              padding: "4px 10px",
                              borderRadius: 99,
                              background: etat.fond,
                              color: etat.texte,
                              font: `500 12px/1.3 ${sansFont}`,
                            }}
                          >
                            {etat.libelle}
                          </span>

                          {s.status === "ACTIVE" && !sansObjet && (
                            <button
                              onClick={() => handleRevokeShare(s.id)}
                              disabled={revokingShareId === s.id}
                              className="ftc-btn-text"
                              style={{
                                padding: "8px 14px",
                                borderRadius: 99,
                                font: `400 13px/1 ${sansFont}`,
                                flex: "none",
                                color: "#d2493c",
                                opacity: revokingShareId === s.id ? 0.5 : 1,
                              }}
                            >
                              {revokingShareId === s.id ? "…" : "Révoquer"}
                            </button>
                          )}
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

                  <div
                    style={{
                      marginTop: 30,
                      maxWidth: 420,
                      padding: 20,
                      borderRadius: 16,
                      border: "1px solid #e6e2da",
                    }}
                  >
                    <div style={{ font: `500 15px/1.3 ${sansFont}`, color: "#16181c" }}>
                      Double authentification
                    </div>
                    <div style={{ marginTop: 8, font: `400 13.5px/1.5 ${sansFont}`, color: "#6b7178" }}>
                      {user?.mfaEnabled
                        ? "Active : un code à six chiffres vous est envoyé par courriel à chaque connexion."
                        : "Inactive : le mot de passe suffit à ouvrir une session. En l'activant, un code vous sera envoyé par courriel à chaque connexion."}
                    </div>

                    <label style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 8 }}>
                      <span style={{ font: `400 13px/1 ${sansFont}`, color: "#6b7178" }}>
                        Confirmez avec votre mot de passe
                      </span>
                      <input
                        type="password"
                        value={mdpMfa}
                        autoComplete="current-password"
                        onChange={(e) => setMdpMfa(e.target.value)}
                        className="ftc-input"
                        style={{ padding: "12px 14px", borderRadius: 11, color: "#16181c", font: `400 14px/1 ${sansFont}` }}
                      />
                    </label>

                    {mfaError && (
                      <div style={{ marginTop: 12, font: `400 13px/1.4 ${sansFont}`, color: "#d2493c" }}>
                        {mfaError}
                      </div>
                    )}
                    {mfaMessage && (
                      <div style={{ marginTop: 12, font: `400 13px/1.4 ${sansFont}`, color: "#3b4046" }}>
                        {mfaMessage}
                      </div>
                    )}

                    <button
                      onClick={() => void basculerMfa(!user?.mfaEnabled)}
                      disabled={mfaBusy || !mdpMfa}
                      className={user?.mfaEnabled ? "ftc-btn-secondary" : "ftc-btn-primary"}
                      style={{
                        marginTop: 16,
                        padding: "12px 20px",
                        borderRadius: 99,
                        font: `500 14px/1 ${sansFont}`,
                        opacity: mfaBusy || !mdpMfa ? 0.55 : 1,
                      }}
                    >
                      {(() => {
                        if (mfaBusy) return "Enregistrement…";
                        return user?.mfaEnabled ? "Désactiver" : "Activer";
                      })()}
                    </button>
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
                          // Ce qui occupe le disque **en ce moment**, tous comptes
                          // confondus — pas ce qui a été déposé depuis le début. Un
                          // fichier effacé ou consommé n'y figure plus.
                          label: "Fichiers stockés",
                          value: String(adminStats.files.total),
                          sub: `${fmtBytes(adminStats.files.totalBytes)} sur le disque`,
                        },
                        {
                          // Total depuis le début, actifs compris : un lien expiré,
                          // révoqué ou consommé reste compté dans le total.
                          label: "Liens créés",
                          value: String(adminStats.shares.total),
                          sub: `${adminStats.shares.active} encore actif${adminStats.shares.active > 1 ? "s" : ""}`,
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

                  {/* Sans ces intitulés, quatre boutons alignés n'annoncent pas sur
                      quoi ils agissent. Nommer les colonnes coûte une ligne et
                      supprime la devinette. */}
                  {adminUsers.length > 0 && (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 14,
                        padding: "0 6px 8px",
                        borderBottom: "1px solid rgba(22,24,28,.06)",
                        font: `500 12px/1 ${sansFont}`,
                        color: "#9aa0a6",
                        letterSpacing: ".04em",
                        textTransform: "uppercase",
                        flexWrap: "wrap",
                      }}
                    >
                      <div style={{ flex: "1 1 240px", minWidth: 210 }}>Compte</div>
                      <div style={{ flex: "none", minWidth: 222 }}>Offre</div>
                      <div style={{ flex: "none", minWidth: 182 }}>Rôle</div>
                      <div style={{ flex: "none", minWidth: 210 }}>Sessions</div>
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
                          <div style={{ flex: "1 1 240px", minWidth: 210 }}>
                            <div style={{ font: `400 15px/1.25 ${sansFont}`, color: "#16181c" }}>
                              {u.email}
                              {isSelf && (
                                <span style={{ marginLeft: 8, font: `400 12.5px/1 ${sansFont}`, color: "#6b7178" }}>
                                  (vous)
                                </span>
                              )}
                            </div>
                            {/* Deux mesures différentes, que la formulation précédente
                                confondait : ce qui est stocké maintenant, et ce qui a été
                                déposé ce mois-ci. Un compte peut afficher 0 fichier et
                                200 Mo consommés — les fichiers ont été effacés depuis. */}
                            <div style={{ marginTop: 4, font: `400 13px/1.3 ${sansFont}`, color: "#6b7178" }}>
                              {u.fileCount} fichier{u.fileCount > 1 ? "s" : ""} stocké{u.fileCount > 1 ? "s" : ""}
                              {" · "}
                              {fmtBytes(u.usedBytesThisMonth)} déposés ce mois sur {fmtBytes(u.quotaBytes)}
                            </div>
                          </div>

                          {/* Chaque état est collé à l'action qui le change. Les
                              présenter en deux blocs séparés — pastilles d'un côté,
                              boutons de l'autre — obligeait à deviner quel bouton
                              agissait sur quoi. */}
                          <div style={{ display: "flex", alignItems: "center", gap: 10, flex: "none" }}>
                            <span
                              style={{
                                display: "inline-block",
                                minWidth: 74,
                                textAlign: "center",
                                padding: "5px 12px",
                                borderRadius: 99,
                                font: `400 12.5px/1 ${sansFont}`,
                                background: u.plan === "PREMIUM" ? "#eafaf1" : "#f6f4f0",
                                color: u.plan === "PREMIUM" ? "#0b6b45" : "#3b4046",
                              }}
                            >
                              {u.plan}
                            </span>
                            <button
                              onClick={() => togglePlan(u)}
                              disabled={busy}
                              className="ftc-btn-secondary"
                              style={{ padding: "8px 14px", borderRadius: 99, font: `400 13px/1 ${sansFont}`, minWidth: 138 }}
                            >
                              {u.plan === "FREE" ? "Passer en PREMIUM" : "Repasser en FREE"}
                            </button>
                          </div>

                          <div style={{ display: "flex", alignItems: "center", gap: 10, flex: "none" }}>
                            <span
                              style={{
                                display: "inline-block",
                                minWidth: 58,
                                textAlign: "center",
                                padding: "5px 12px",
                                borderRadius: 99,
                                font: `400 12.5px/1 ${sansFont}`,
                                background: u.role === "ADMIN" ? "#ece9ff" : "#f6f4f0",
                                color: u.role === "ADMIN" ? "#3527cc" : "#3b4046",
                              }}
                            >
                              {u.role}
                            </span>
                            <button
                              onClick={() => toggleRole(u)}
                              disabled={busy || isSelf}
                              title={isSelf ? "Un administrateur ne peut pas retirer ses propres droits : il se verrouillerait dehors." : undefined}
                              className="ftc-btn-secondary"
                              style={{ padding: "8px 14px", borderRadius: 99, font: `400 13px/1 ${sansFont}`, minWidth: 114, opacity: isSelf ? 0.45 : 1 }}
                            >
                              {u.role === "USER" ? "Rendre admin" : "Retirer admin"}
                            </button>
                          </div>

                          <div style={{ display: "flex", alignItems: "center", gap: 10, flex: "none", minWidth: 210 }}>
                            <button
                              onClick={() => handleRevokeSessions(u)}
                              disabled={busy}
                              title="Révoque les jetons de renouvellement du compte : il ne pourra plus prolonger sa session et devra se reconnecter. Sa session en cours reste valable jusqu'à 15 minutes."
                              className="ftc-btn-text"
                              style={{ padding: "8px 14px", borderRadius: 99, font: `400 13px/1 ${sansFont}`, color: "#d2493c" }}
                            >
                              Déconnecter partout
                            </button>
                            {sessionsCoupees[u.id] !== undefined && (
                              <span style={{ font: `400 12.5px/1.3 ${sansFont}`, color: "#1e7a3c" }}>
                                {sessionsCoupees[u.id]} session{sessionsCoupees[u.id] > 1 ? "s" : ""} coupée{sessionsCoupees[u.id] > 1 ? "s" : ""}
                              </span>
                            )}
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
