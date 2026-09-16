const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface User {
  id: string;
  email: string;
  role?: string;
}

export interface CurrentUser {
  id: string;
  email: string;
}

export interface Quota {
  plan: "FREE" | "PREMIUM";
  usedBytes: number;
  limitBytes: number;
  remainingBytes: number;
  period: string;
}

export interface FileItem {
  id: string;
  originalName: string;
  sizeBytes: number;
  createdAt: string;
}

export type ShareStatus = "ACTIVE" | "EXPIRED" | "REVOKED";

export interface SharedFile {
  id: string;
  fileName: string;
  sizeBytes: number;
}

export interface Share {
  id: string;
  files: SharedFile[];
  recipientEmail?: string;
  protectedByPassword: boolean;
  status: ShareStatus;
  expiresAt: string;
  createdAt: string;
}

export interface CreatedShare extends Share {
  token: string;
}

export interface ShareInfo {
  requiresPassword: boolean;
  expiresAt: string;
  files?: SharedFile[];
}

export interface CreateShareInput {
  fileIds: string[];
  expiresInHours?: number;
  password?: string;
  recipientEmail?: string;
}

interface ApiErrorBody {
  error?: string;
  message?: string | string[];
}

function messageFrom(body: ApiErrorBody, fallback: string): string {
  if (Array.isArray(body.message)) return body.message.join(" ");
  return body.message ?? fallback;
}

async function parseErrorResponse(res: Response): Promise<ApiError> {
  let body: ApiErrorBody = {};
  try {
    body = await res.json();
  } catch {
    // corps non-JSON, on garde le statut HTTP tel quel
  }
  return new ApiError(res.status, messageFrom(body, res.statusText), body.error);
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  skipRefresh?: boolean;
}

let refreshInFlight: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = request<{ refreshed: true }>("/api/auth/refresh", {
      method: "POST",
      skipRefresh: true,
    })
      .then(() => true)
      .catch(() => false)
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, skipRefresh } = opts;
  const isMutating = method !== "GET" && method !== "HEAD";
  const headers: Record<string, string> = {};
  if (isMutating) headers["X-Requested-With"] = "XMLHttpRequest";
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    credentials: "include",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 401 && !skipRefresh) {
    const refreshed = await tryRefresh();
    if (refreshed) return request<T>(path, { ...opts, skipRefresh: true });
  }

  if (!res.ok) throw await parseErrorResponse(res);
  if (res.status === HTTP_NO_CONTENT) return undefined as T;

  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const HTTP_NO_CONTENT = 204;

function uploadFile(file: File, onProgress?: (fraction: number) => void): Promise<FileItem> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE}/api/files`);
    xhr.withCredentials = true;
    xhr.setRequestHeader("X-Requested-With", "XMLHttpRequest");

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total);
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(xhr.responseText ? JSON.parse(xhr.responseText) : undefined);
        } catch {
          reject(new ApiError(xhr.status, "Réponse du serveur illisible."));
        }
        return;
      }
      let body: ApiErrorBody = {};
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : {};
      } catch {
        // ignore
      }
      reject(new ApiError(xhr.status, messageFrom(body, xhr.statusText), body.error));
    };

    xhr.onerror = () => reject(new ApiError(0, "Erreur réseau pendant l'envoi."));

    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
}

/**
 * Décrit un lien de partage, sans compte requis. Fournir le mot de passe
 * révèle la liste des fichiers en une seule fois, sans le ressaisir pour
 * chaque téléchargement individuel.
 */
async function shareInfo(token: string, password?: string): Promise<ShareInfo> {
  const headers: Record<string, string> = {};
  if (password) headers["X-Share-Password"] = password;

  const res = await fetch(`${API_BASE}/api/download/${token}/info`, { headers });
  if (!res.ok) throw await parseErrorResponse(res);
  return res.json();
}

/**
 * Télécharge un fichier d'un partage et déclenche l'enregistrement dans le
 * navigateur. Sans compte : le jeton (et le mot de passe, s'il y en a un)
 * suffisent.
 */
async function downloadShare(
  token: string,
  fileId: string,
  fileName: string,
  password?: string,
): Promise<void> {
  const headers: Record<string, string> = {};
  if (password) headers["X-Share-Password"] = password;

  const res = await fetch(`${API_BASE}/api/download/${token}/file/${fileId}`, { headers });
  if (!res.ok) throw await parseErrorResponse(res);

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export const api = {
  register: (email: string, password: string) =>
    request<User>("/api/auth/register", { method: "POST", body: { email, password } }),
  login: (email: string, password: string) =>
    request<User>("/api/auth/login", { method: "POST", body: { email, password } }),
  logout: () => request<void>("/api/auth/logout", { method: "POST" }),
  me: () => request<CurrentUser>("/api/auth/me"),
  quota: () => request<Quota>("/api/files/quota"),
  listFiles: () => request<FileItem[]>("/api/files"),
  deleteFile: (id: string) => request<void>(`/api/files/${id}`, { method: "DELETE" }),
  uploadFile,
  createShare: (input: CreateShareInput) =>
    request<CreatedShare>("/api/shares", { method: "POST", body: input }),
  listShares: () => request<Share[]>("/api/shares"),
  revokeShare: (id: string) => request<void>(`/api/shares/${id}/revoke`, { method: "PATCH" }),
  shareInfo,
  downloadShare,
};
