import { useState, type FormEvent, type ReactNode } from "react";
import { api, errorText } from "./api";
import { Alert, fmtDate, Loading, useLoad } from "./ui";

export type Clip = { id: number; source: string; title: string; body: string; url: string | null; created_at: string };
export type NewClip = { title: string; body: string; url?: string | null; source: string };

const SOURCE: Record<string, string> = { manual: "Skrevet", extension: "Web", outlook: "Outlook", word: "Word", mobile: "Mobil" };

export function saveClip(clip: NewClip): Promise<Clip> {
  return api.post<Clip>("/api/clips", { ...clip, title: clip.title.slice(0, 300) || "Uden titel" });
}

export function useClips() {
  const [q, setQ] = useState("");
  const list = useLoad(() => api.get<Clip[]>(`/api/clips${q ? `?q=${encodeURIComponent(q)}` : ""}`), [q]);
  return { ...list, q, setQ };
}

/** A searchable list of the user's clips. `actions` renders buttons per clip (insert in Word, …). */
export function ClipsList({ clips, actions, compact = false, source = "manual" }: {
  clips: ReturnType<typeof useClips>;
  actions?: (clip: Clip) => ReactNode;
  compact?: boolean;
  source?: string;
}) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await saveClip({ title, body, source });
      setTitle("");
      setBody("");
      setAdding(false);
      await clips.reload();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const remove = async (c: Clip) => {
    if (!confirm(`Slet klippet "${c.title}"?`)) return;
    try {
      await api.del(`/api/clips/${c.id}`);
      await clips.reload();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className="stack">
      <div className="row">
        <input placeholder="Søg i klip" value={clips.q} onChange={(e) => clips.setQ(e.target.value)} style={{ flex: 1, minWidth: 0 }} />
        <button className="btn btn-outline btn-sm" onClick={() => setAdding(!adding)}>{adding ? "Luk" : "Nyt klip"}</button>
      </div>
      {adding && (
        <form className="card" onSubmit={add}>
          <label className="field">Titel<input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={300} /></label>
          <label className="field">Tekst<textarea value={body} onChange={(e) => setBody(e.target.value)} /></label>
          <div><button className="btn btn-primary btn-sm">Gem klip</button></div>
        </form>
      )}
      <Alert>{error || clips.error}</Alert>
      {clips.loading && !clips.data ? <Loading /> : clips.data?.length === 0 ? (
        <p className="muted small">Ingen klip endnu.</p>
      ) : (
        clips.data?.map((c) => (
          <div key={c.id} className="card" style={{ padding: compact ? "12px 14px" : undefined, gap: 6 }}>
            <div className="spread" style={{ alignItems: "flex-start" }}>
              <button onClick={() => setOpen(open === c.id ? null : c.id)} aria-expanded={open === c.id}
                      style={{ background: "none", border: 0, padding: 0, textAlign: "left", cursor: "pointer", font: "inherit", color: "inherit", flex: 1, minWidth: 0 }}>
                <strong style={{ wordBreak: "break-word" }}>{c.title}</strong>
                <div className="muted tiny">{SOURCE[c.source] ?? c.source} · {fmtDate(c.created_at)}</div>
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => remove(c)} aria-label="Slet">Slet</button>
            </div>
            {(open === c.id || !compact) && c.body && (
              <p className="small" style={{ whiteSpace: "pre-wrap", maxHeight: open === c.id ? "none" : 72, overflow: "hidden", color: "#334155" }}>{c.body}</p>
            )}
            {c.url && open === c.id && <a className="tiny" href={c.url} target="_blank" rel="noreferrer" style={{ wordBreak: "break-all" }}>{c.url}</a>}
            {actions && <div className="row" style={{ "--gap": "6px" } as React.CSSProperties}>{actions(c)}</div>}
          </div>
        ))
      )}
    </div>
  );
}

export default function ClipsPage() {
  const clips = useClips();
  return (
    <div className="page" style={{ maxWidth: 820 }}>
      <div className="stack" style={{ "--gap": "8px" } as React.CSSProperties}>
        <div className="eyebrow">Klip</div>
        <h2>Dine klip</h2>
        <p className="muted">Tekst, du har gemt fra websider, mails eller selv har skrevet. Indsæt dem i Word og Outlook via tilføjelserne.</p>
      </div>
      <ClipsList clips={clips} actions={(c) => (
        <button className="btn btn-outline btn-sm" onClick={() => navigator.clipboard.writeText(c.body)}>Kopiér</button>
      )} />
    </div>
  );
}
