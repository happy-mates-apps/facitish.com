// Side menu of the /admin app: the mark and the tools stay at the top, the server status at the bottom; only the
// menu itself scrolls, with sticky group headings. The search tool (⌘K) filters the menu and marks what matched.
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { ArrowLeft, Search, X, type LucideIcon } from "lucide-react";
import { useAuth } from "../auth";
import { useAdmin } from "./context";
import { filterNav, navFor, navTerms, type NavBadge, type Range } from "./nav";
import ToergaerMark from "./ToergaerMark";
import { MONO, SANS } from "./theme";

const BG = "#0f172a";
const DIM = "rgba(255,255,255,0.6)";
const heading: CSSProperties = { fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "rgba(255,255,255,0.45)" };

export default function SideMenu() {
  const { user, config } = useAuth();
  const { impersonating, missingFeatures, pendingDrafts, health, openReplies, openReports } = useAdmin();
  const navigate = useNavigate();
  const instance = config?.app_name ?? window.location.hostname;
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const terms = navTerms(query);
  const groups = filterNav(navFor(user?.admin_sections), query);

  const closeSearch = () => {
    setQuery("");
    setSearching(false);
  };

  useEffect(() => {
    if (searching) inputRef.current?.focus();
  }, [searching]);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearching(true);
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (query) setQuery("");
      else closeSearch();
    } else if (e.key === "Enter" && terms.length) {
      const first = groups[0]?.items[0];
      if (!first) return;
      e.preventDefault();
      navigate(first.item.path);
      closeSearch();
    }
  };

  const badge = (b?: NavBadge): { text: string; amber: boolean } | null => {
    if (b === "impersonation" && impersonating) return { text: "Aktiv", amber: true };
    if (b === "features" && missingFeatures) return { text: String(missingFeatures), amber: true };
    if (b === "mcp" && pendingDrafts) return { text: String(pendingDrafts), amber: true };
    if (b === "replies" && openReplies) return { text: String(openReplies), amber: true };
    if (b === "reports" && openReports) return { text: String(openReports), amber: true };
    return null;
  };

  return (
    <aside className="tg-side" style={{ position: "sticky", top: 0, height: "100vh", width: 232, flex: "none", boxSizing: "border-box", display: "flex",
      flexDirection: "column", background: BG, color: "#ffffff", padding: "20px 10px 16px" }}>
      <div style={{ flex: "none", display: "flex", flexDirection: "column", gap: 6, padding: "0 10px 14px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <ToergaerMark size={28} byline={false} dark />
          <div role="toolbar" aria-label="Menuværktøjer" style={{ display: "flex", gap: 2 }}>
            <ToolBtn icon={Search} label="Søg i menuen (⌘K)" on={searching} onClick={() => (searching ? closeSearch() : setSearching(true))} />
          </div>
        </div>
        <span style={{ fontSize: 11, color: DIM, fontFamily: MONO }}>/admin · {instance}</span>
      </div>

      {searching && (
        <div style={{ flex: "none", position: "relative", display: "flex", margin: "0 0 12px" }}>
          <Search size={14} color="rgba(255,255,255,0.55)" strokeWidth={2} aria-hidden style={{ position: "absolute", left: 10, top: 10, pointerEvents: "none" }} />
          <input ref={inputRef} className="tg-side-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onSearchKey}
            aria-label="Søg i menuen" placeholder="Søg kommando" autoComplete="off" spellCheck={false}
            style={{ width: "100%", height: 34, boxSizing: "border-box", padding: "0 34px 0 30px", border: "1px solid rgba(255,255,255,0.14)", borderRadius: 8,
              background: "rgba(255,255,255,0.06)", color: "#ffffff", font: `13px ${SANS}`, outline: "none" }} />
          {query ? (
            <button type="button" className="tg-side-tool" aria-label="Ryd søgning" title="Ryd søgning" onClick={() => { setQuery(""); inputRef.current?.focus(); }}
              style={{ position: "absolute", right: 5, top: 5, width: 24, height: 24, display: "inline-flex", alignItems: "center", justifyContent: "center",
                border: 0, borderRadius: 6, background: "transparent", color: DIM, cursor: "pointer" }}>
              <X size={13} strokeWidth={2} />
            </button>
          ) : (
            <kbd aria-hidden style={{ position: "absolute", right: 8, top: 8, padding: "1px 6px", borderRadius: 5, border: "1px solid rgba(255,255,255,0.2)",
              font: `11px ${SANS}`, color: DIM }}>Esc</kbd>
          )}
        </div>
      )}

      <nav className="tg-side-nav" aria-label="Admin" style={{ flex: 1, minHeight: 0, overflowY: "auto", scrollPaddingTop: 26, display: "flex", flexDirection: "column",
        gap: 10, margin: "0 -10px", padding: "0 10px" }}>
        {groups.map(({ group: g, ranges, items }) => (
          <div key={g.label} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <div className="tg-side-heading" style={{ ...heading, position: "sticky", top: 0, zIndex: 1, display: "flex", alignItems: "center",
              justifyContent: "space-between", gap: 8, padding: "6px 10px 4px", background: BG }}>
              <span><Mark text={g.label} ranges={ranges} /></span>
              {terms.length > 0 && <span style={{ letterSpacing: 0, fontWeight: 600 }}>{items.length}</span>}
            </div>
            {items.map(({ item: n, ranges: hit }) => {
              const b = badge(n.badge);
              return (
                <NavLink key={n.path} to={n.path} end={n.path === "/" || n.path === "/data" || n.path === "/adoption" || n.path === "/messages"}
                  onClick={() => searching && closeSearch()} style={{ textDecoration: "none" }}>
                  {({ isActive }) => (
                    <span className={isActive ? undefined : "tg-nav"} style={{ position: "relative", display: "flex", alignItems: "center", gap: 10, width: "100%",
                      boxSizing: "border-box", padding: "8px 10px", borderRadius: 8, font: `${isActive ? 600 : 400} 13px ${SANS}`,
                      background: isActive ? "rgba(255,255,255,0.1)" : "transparent", color: isActive ? "#ffffff" : "rgba(255,255,255,0.72)" }}>
                      <span style={{ position: "absolute", left: 0, top: "50%", width: 2, height: 16, marginTop: -8, borderRadius: 2,
                        background: isActive ? "#fcbf49" : "transparent" }} />
                      <n.icon size={16} strokeWidth={2} style={{ flex: "none" }} />
                      <span style={{ flex: 1, minWidth: 0 }}><Mark text={n.label} ranges={hit} /></span>
                      {b && (
                        <span style={{ minWidth: 18, padding: "0 6px", boxSizing: "border-box", borderRadius: 9999, background: b.amber ? "#f59e0b" : "#dc2626",
                          color: b.amber ? "#0f172a" : "#ffffff", fontSize: 10, fontWeight: 700, textAlign: "center", lineHeight: "18px" }}>{b.text}</span>
                      )}
                    </span>
                  )}
                </NavLink>
              );
            })}
          </div>
        ))}
        {groups.length === 0 && (
          <div role="status" style={{ padding: "12px 10px", fontSize: 12, color: DIM, lineHeight: 1.5, textWrap: "pretty" }}>
            Ingen kommandoer matcher “{query.trim()}”.
          </div>
        )}
      </nav>

      <div style={{ flex: "none", marginTop: 12, padding: "12px 10px 0", borderTop: "1px solid rgba(255,255,255,0.1)", display: "flex", flexDirection: "column",
        gap: 10, fontSize: 12, color: "rgba(255,255,255,0.7)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 8, height: 8, borderRadius: 9999, background: health && !health.ok ? "#dc2626" : "#10b981",
            animation: health?.ok ? "tgpulse 2s infinite" : "none" }} />
          {health && !health.ok ? "Server svarer ikke" : `Server online · v${health?.version ?? "…"}`}
        </div>
        <a href="/" style={{ display: "flex", alignItems: "center", gap: 6, color: "rgba(255,255,255,0.7)", textDecoration: "none" }}>
          <ArrowLeft size={12} strokeWidth={2} />Til appen på /
        </a>
      </div>
    </aside>
  );
}

function ToolBtn({ icon: Icon, label, on, onClick }: { icon: LucideIcon; label: string; on: boolean; onClick: () => void }) {
  return (
    <button type="button" className="tg-side-tool" aria-label={label} title={label} aria-pressed={on} onClick={onClick}
      style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, border: 0, borderRadius: 7, cursor: "pointer",
        background: on ? "rgba(255,255,255,0.12)" : "transparent", color: on ? "#ffffff" : DIM }}>
      <Icon size={15} strokeWidth={2} />
    </button>
  );
}

const mark: CSSProperties = { background: "rgba(252,191,73,0.3)", color: "#ffffff", borderRadius: 3, padding: "0 1px", margin: "0 -1px" };

/** The text with the matching characters marked. */
function Mark({ text, ranges }: { text: string; ranges: Range[] }) {
  if (!ranges.length) return <>{text}</>;
  const parts: ReactNode[] = [];
  let pos = 0;
  ranges.forEach(([start, end], i) => {
    if (start > pos) parts.push(text.slice(pos, start));
    parts.push(<mark key={i} style={mark}>{text.slice(start, end)}</mark>);
    pos = end;
  });
  if (pos < text.length) parts.push(text.slice(pos));
  return <>{parts}</>;
}
