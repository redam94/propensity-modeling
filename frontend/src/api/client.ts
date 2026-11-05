import type {
  AnalysisConfig,
  AnalysisSubmitted,
  DatasetProfile,
  HealthResponse,
  JobDetail,
  JobInfo,
} from "./types";

export const API_BASE = "/api";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

interface ValidationItem {
  loc?: (string | number)[];
  msg?: string;
  type?: string;
}

/** Turn a FastAPI error body (`{detail: string | ValidationItem[]}`) into readable text. */
export function formatErrorDetail(body: unknown, fallback: string): string {
  if (body == null) return fallback;
  if (typeof body === "string") return body || fallback;
  if (typeof body !== "object") return fallback;
  const detail = (body as { detail?: unknown }).detail;
  if (detail == null) return fallback;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const lines = detail.map((d) => {
      if (typeof d === "string") return d;
      const item = d as ValidationItem;
      const loc = (item.loc ?? []).filter((p) => p !== "body").join(" → ");
      return loc ? `${loc}: ${item.msg ?? "invalid"}` : item.msg ?? JSON.stringify(d);
    });
    return lines.join("\n");
  }
  if (typeof detail === "object") return JSON.stringify(detail);
  return String(detail);
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch (e) {
    throw new ApiError(0, `Cannot reach the API server (${(e as Error).message}). Is the backend running on :8000?`);
  }
  if (res.status === 204) return undefined as T;
  const body = await parseBody(res);
  if (!res.ok) {
    throw new ApiError(res.status, formatErrorDetail(body, `${res.status} ${res.statusText}`));
  }
  return body as T;
}

function qs(params: Record<string, string | null | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v != null && v !== "") as [string, string][];
  if (!entries.length) return "";
  return "?" + new URLSearchParams(entries).toString();
}

// ---------------------------------------------------------------- health
export const getHealth = () => request<HealthResponse>("/health");

// ---------------------------------------------------------------- datasets
export const listDatasets = () => request<DatasetProfile[]>("/datasets");

export const getDataset = (datasetId: string, sheet?: string | null) =>
  request<DatasetProfile>(`/datasets/${encodeURIComponent(datasetId)}${qs({ sheet })}`);

export const deleteDataset = (datasetId: string) =>
  request<void>(`/datasets/${encodeURIComponent(datasetId)}`, { method: "DELETE" });

/**
 * Upload a file with progress reporting (XHR, since fetch has no upload progress).
 * `onProgress` receives a fraction 0-1.
 */
export function uploadDataset(
  file: File,
  opts: { sheet?: string | null; onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
): Promise<DatasetProfile> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE}/datasets${qs({ sheet: opts.sheet })}`);
    xhr.setRequestHeader("Accept", "application/json");
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) opts.onProgress?.(ev.loaded / ev.total);
    };
    xhr.onload = () => {
      let body: unknown = xhr.responseText;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* keep text */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as DatasetProfile);
      else reject(new ApiError(xhr.status, formatErrorDetail(body, `Upload failed (${xhr.status})`)));
    };
    xhr.onerror = () => reject(new ApiError(0, "Network error during upload. Is the backend running?"));
    xhr.onabort = () => reject(new ApiError(0, "Upload cancelled"));
    opts.signal?.addEventListener("abort", () => xhr.abort());
    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
}

// ---------------------------------------------------------------- analyses
export const submitAnalysis = (config: AnalysisConfig) =>
  request<AnalysisSubmitted>("/analyses", { method: "POST", body: JSON.stringify(config) });

export const listAnalyses = () => request<JobInfo[]>("/analyses");

export const getAnalysis = (analysisId: string) =>
  request<JobDetail>(`/analyses/${encodeURIComponent(analysisId)}`);

/** Cancels if queued/running, otherwise deletes. */
export const deleteAnalysis = (analysisId: string) =>
  request<void>(`/analyses/${encodeURIComponent(analysisId)}`, { method: "DELETE" });

export const exportUrl = (analysisId: string) =>
  `${API_BASE}/analyses/${encodeURIComponent(analysisId)}/export`;

/** Download the Excel export, surfacing server errors instead of silently saving an error page. */
export async function downloadExport(analysisId: string, filename?: string): Promise<void> {
  const res = await fetch(exportUrl(analysisId));
  if (!res.ok) {
    const body = await parseBody(res);
    throw new ApiError(res.status, formatErrorDetail(body, `Export failed (${res.status})`));
  }
  const blob = await res.blob();
  const cd = res.headers.get("Content-Disposition") ?? "";
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
  const name = filename ?? (m ? decodeURIComponent(m[1]) : `analysis_${analysisId}.xlsx`);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const isActive = (s: JobInfo["status"]) => s === "queued" || s === "running";
