import { useCallback, useEffect, useState, type ReactNode } from "react";
import { errorText } from "./api";

export function useLoad<T>(loader: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(loader, deps);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await load());
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [load]);
  useEffect(() => {
    reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}

export function PageHeader({ eyebrow, title, children }: { eyebrow: string; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="stack" style={{ "--gap": "8px" } as React.CSSProperties}>
      <div className="eyebrow">{eyebrow}</div>
      <h2>{title}</h2>
      {children && <p className="muted" style={{ maxWidth: 760 }}>{children}</p>}
    </div>
  );
}

export function Alert({ kind = "error", children }: { kind?: "error" | "info" | "success" | "warn"; children: ReactNode }) {
  if (!children) return null;
  return <div className={`alert ${kind}`}>{children}</div>;
}

export function Loading() {
  return <p className="muted small">Henter …</p>;
}

const dateFmt = new Intl.DateTimeFormat("da-DK", { dateStyle: "medium", timeStyle: "short" });
const dayFmt = new Intl.DateTimeFormat("da-DK", { dateStyle: "medium" });

export function fmtDate(value: string | null | undefined): string {
  return value ? dateFmt.format(new Date(value)) : "—";
}

export function fmtDay(value: string | null | undefined): string {
  return value ? dayFmt.format(new Date(value)) : "—";
}

export function fmtNumber(value: number | null | undefined): string {
  return new Intl.NumberFormat("da-DK").format(value ?? 0);
}

export function fmtBytes(bytes: number | null | undefined): string {
  const b = bytes ?? 0;
  if (b < 1024) return `${b} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = b / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toLocaleString("da-DK", { maximumFractionDigits: 1 })} ${units[i]}`;
}

export function Pager({ total, limit, offset, onChange }: { total: number; limit: number; offset: number; onChange: (o: number) => void }) {
  if (total <= limit) return <p className="muted small">{fmtNumber(total)} i alt</p>;
  return (
    <div className="spread">
      <span className="muted small">
        {fmtNumber(offset + 1)}–{fmtNumber(Math.min(offset + limit, total))} af {fmtNumber(total)}
      </span>
      <div className="row">
        <button className="btn btn-outline btn-sm" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>
          Forrige
        </button>
        <button className="btn btn-outline btn-sm" disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>
          Næste
        </button>
      </div>
    </div>
  );
}

export function Json({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="muted">—</span>;
  if (typeof value === "object" && Object.keys(value as object).length === 0) return <span className="muted">—</span>;
  return <pre className="json">{JSON.stringify(value, null, 1)}</pre>;
}

export function download(url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
