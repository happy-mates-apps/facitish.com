// /admin/adoption/console → Live-strøm: route visits as they happen (server-sent events from /api/admin/adoption/stream),
// with filters per journey, pause and a filter on route or user.
import { useEffect, useRef, useState } from "react";
import { Btn } from "../../ui";
import { MONO, SANS } from "../../theme";
import { useAdoption } from "./shared";

export type LiveLine = {
  id: number; at: string; path: string; surface: string; user: string | null;
  hits: { journey_id: number; journey_name: string; step: number }[];
};

/** The live stream: newest first, at most 200 lines. While paused, new lines are dropped. */
export function useLiveLines(paused = false) {
  const [lines, setLines] = useState<LiveLine[]>([]);
  const [connected, setConnected] = useState(false);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    let last = 0;
    let source: EventSource | null = null;
    let closed = false;
    const open = () => {
      source = new EventSource(`/api/admin/adoption/stream?after=${last}`);
      source.onopen = () => setConnected(true);
      source.onmessage = (e) => {
        const batch = JSON.parse(e.data) as { lines: LiveLine[]; last_id: number };
        last = batch.last_id;
        if (!pausedRef.current) setLines((prev) => [...batch.lines, ...prev].slice(0, 200));
      };
      source.onerror = () => {
        setConnected(false);
        // The server ends the stream after a few minutes; reopen from the last id seen (EventSource would restart at 0).
        source?.close();
        if (!closed) window.setTimeout(open, 3000);
      };
    };
    open();
    return () => {
      closed = true;
      source?.close();
    };
  }, []);
  return { lines, connected };
}

export default function AdoptionConsole() {
  const { journeys } = useAdoption();
  const [paused, setPaused] = useState(false);
  const { lines, connected } = useLiveLines(paused);
  const [filter, setFilter] = useState<string>("all");
  const [query, setQuery] = useState("");

  const options = [{ id: "all", label: "Alle besøg" }, { id: "hits", label: "Kun målepunkter" },
    ...(journeys ?? []).filter((j) => j.status === "active").map((j) => ({ id: String(j.id), label: j.name }))];
  const q = query.trim().toLowerCase();
  const shown = lines.filter((l) =>
    (filter === "all" || (filter === "hits" ? l.hits.length > 0 : l.hits.some((h) => String(h.journey_id) === filter)))
    && (!q || l.path.toLowerCase().includes(q) || (l.user ?? "").toLowerCase().includes(q)));
  const hitText = (l: LiveLine) => {
    const h = filter !== "all" && filter !== "hits" ? l.hits.find((x) => String(x.journey_id) === filter) : l.hits[0];
    return h ? `✓ ${h.journey_name} · trin ${h.step}${l.hits.length > 1 && filter === "all" ? ` (+${l.hits.length - 1})` : ""}` : "—";
  };

  return (
    <>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        {options.map((o) => {
          const on = o.id === filter;
          return (
            <button key={o.id} type="button" aria-pressed={on} onClick={() => setFilter(o.id)}
              style={{ padding: "7px 12px", borderRadius: 9999, cursor: "pointer", font: `13px ${SANS}`,
                border: `1px solid ${on ? "#020817" : "#e2e8f0"}`, background: on ? "#020817" : "#ffffff", color: on ? "#ffffff" : "#020817" }}>
              {o.label}
            </button>
          );
        })}
        <span style={{ flex: 1 }} />
        <Btn height={32} onClick={() => setPaused((p) => !p)}>{paused ? "Fortsæt" : "Pause"}</Btn>
      </div>

      <section style={{ display: "flex", flexDirection: "column", minHeight: 520, borderRadius: 16, background: "#020817", overflow: "hidden" }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, padding: "12px 18px", borderBottom: "1px solid rgba(255,255,255,0.08)",
          fontFamily: MONO, fontSize: 12, color: "#94a3b8" }}>
          <span style={{ width: 8, height: 8, borderRadius: 9999, background: paused || !connected ? "#f59e0b" : "#22c55e" }} />
          <span>adoption://live · rutebesøg{paused ? " · pauset" : connected ? "" : " · forbinder …"}</span>
          <span style={{ flex: 1 }} />
          <span>{shown.length} hændelser · {shown.filter((l) => l.hits.length > 0).length} målepunkter</span>
        </div>
        <div style={{ flex: 1, overflow: "auto", maxHeight: 560, padding: "14px 18px" }}>
          <div style={{ minWidth: 640, display: "flex", flexDirection: "column", gap: 6, fontFamily: MONO, fontSize: 12.5, lineHeight: 1.5 }}>
            {shown.length === 0 && (
              <span style={{ color: "#94a3b8" }}>Ingen rutebesøg endnu{q || filter !== "all" ? " der matcher filteret" : ""} …</span>
            )}
            {shown.slice(0, 80).map((l) => (
              <div key={l.id} style={{ display: "grid", gridTemplateColumns: "72px 72px minmax(0,1fr) 130px minmax(0,1.1fr)", alignItems: "baseline", gap: 12 }}>
                <span style={{ color: "#94a3b8" }}>{new Date(l.at).toLocaleTimeString("da-DK")}</span>
                <span style={{ color: "#a5b4fc" }}>{l.surface}</span>
                <span style={{ color: "#f1f5f9", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.path}</span>
                <span style={{ color: "#94a3b8", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.user ?? "—"}</span>
                <span style={{ color: l.hits.length ? "#86efac" : "#64748b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{hitText(l)}</span>
              </div>
            ))}
          </div>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 18px", borderTop: "1px solid rgba(255,255,255,0.08)",
          fontFamily: MONO, fontSize: 13, color: "#86efac" }}>
          ›
          <input value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Filtrér på rute eller bruger"
            placeholder="filtrér på rute eller bruger, fx /klip"
            style={{ flex: 1, border: 0, background: "transparent", font: "inherit", color: "#f1f5f9", outline: "none" }} />
        </label>
      </section>
      <p style={{ margin: 0, fontSize: 12, color: "#64748b" }}>
        Brugere vises med visningsnavn. Strømmen genopretter forbindelsen af sig selv efter nogle minutter.
      </p>
    </>
  );
}
