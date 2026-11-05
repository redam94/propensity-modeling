import type { ReactNode } from "react";
import type { JobStatus } from "../api/types";
import { sigLabel, sigLevel } from "../lib/format";

export function Spinner({ small }: { small?: boolean }) {
  return <span className={`spinner${small ? " sm" : ""}`} aria-hidden />;
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <Spinner />
      <span>{label}</span>
    </div>
  );
}

export function ErrorBox({ error, title = "Something went wrong", onRetry }: { error: unknown; title?: string; onRetry?: () => void }) {
  const msg = error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error";
  return (
    <div className="callout error" role="alert">
      <div className="callout-title">{title}</div>
      <div className="pre-line">{msg}</div>
      {onRetry && (
        <div style={{ marginTop: 8 }}>
          <button className="btn sm" onClick={onRetry}>
            Retry
          </button>
        </div>
      )}
    </div>
  );
}

export function Empty({ title, children, actions }: { title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <div>{children}</div>}
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

export function Callout({
  kind = "info",
  title,
  children,
}: {
  kind?: "info" | "warn" | "error" | "success";
  title?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={`callout ${kind}`}>
      {title && <div className="callout-title">{title}</div>}
      {children}
    </div>
  );
}

export function Card({
  title,
  desc,
  actions,
  children,
  flush,
  footer,
  className,
}: {
  title?: ReactNode;
  desc?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  flush?: boolean;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card${className ? " " + className : ""}`}>
      {(title || actions) && (
        <div className="card-head">
          <div style={{ minWidth: 0 }}>
            {title && <h3>{title}</h3>}
            {desc && <div className="desc">{desc}</div>}
          </div>
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      <div className={`card-body${flush ? " flush" : ""}`}>{children}</div>
      {footer && <div className="card-foot">{footer}</div>}
    </section>
  );
}

export function Kpi({
  label,
  value,
  hint,
  tone,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "exposed" | "control";
}) {
  return (
    <div className={`kpi${tone ? " " + tone : ""}`}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export function ProgressBar({ value, status }: { value: number; status?: JobStatus }) {
  const pct = Math.max(0, Math.min(1, value || 0)) * 100;
  const cls =
    status === "completed" ? " done" : status === "failed" ? " fail" : status === "queued" ? " indeterminate" : "";
  return (
    <div className={`progress${cls}`} role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div style={{ width: `${status === "completed" ? 100 : pct}%` }} />
    </div>
  );
}

export function StatusBadge({ status }: { status: JobStatus }) {
  return (
    <span className={`badge ${status}`}>
      {(status === "running" || status === "queued") && <Spinner small />}
      {status}
    </span>
  );
}

export function SigBadge({ p, lift, alpha }: { p: number; lift: number; alpha?: number }) {
  const lvl = sigLevel(p, lift, alpha);
  return <span className={`badge ${lvl}`}>{sigLabel(lvl)}</span>;
}

export function Seg<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="seg" role="group">
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} className={o.value === value ? "on" : ""} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function GroupLegend() {
  return (
    <div className="legend">
      <span>
        <i style={{ background: "var(--exposed)" }} />
        Exposed
      </span>
      <span>
        <i style={{ background: "var(--control)" }} />
        Control
      </span>
    </div>
  );
}

/* ---- tiny inline icons (no icon library) ---- */
const ip = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
export const Icon = {
  upload: () => (
    <svg {...ip}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  ),
  sliders: () => (
    <svg {...ip}>
      <line x1="4" y1="21" x2="4" y2="14" />
      <line x1="4" y1="10" x2="4" y2="3" />
      <line x1="12" y1="21" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12" y2="3" />
      <line x1="20" y1="21" x2="20" y2="16" />
      <line x1="20" y1="12" x2="20" y2="3" />
      <line x1="1" y1="14" x2="7" y2="14" />
      <line x1="9" y1="8" x2="15" y2="8" />
      <line x1="17" y1="16" x2="23" y2="16" />
    </svg>
  ),
  list: () => (
    <svg {...ip}>
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  ),
  chart: () => (
    <svg {...ip}>
      <path d="M3 3v18h18" />
      <path d="M7 15l4-5 4 3 5-7" />
    </svg>
  ),
  download: () => (
    <svg {...ip} width={16} height={16}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  ),
  file: () => (
    <svg {...ip} width={16} height={16}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  ),
};
