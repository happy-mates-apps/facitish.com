// The review panel: see the app as a ring sees it, point at what must be fixed, and run test sessions as an
// archetype. Notes, screenshots, audio and sessions are saved on the server for the logged-in user and can be
// zipped for the developer. Loaded lazily by ReviewLauncher; only logged-in users get here.
import {
  useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Camera, ChevronDown, ChevronUp, Download, Meh, Mic, MousePointerClick, PanelLeft, PanelRight, Square,
  SquareDashed, ThumbsDown, ThumbsUp, Trash2, X,
} from "lucide-react";
import { errorText } from "../api";
import { useAuth } from "../auth";
import { effectiveRing, useFeatures, useMountedGates, viewLevel } from "../features";
import { canCaptureScreen, canRecord, captureScreen, startRecording, type Recording } from "./capture";
import { AreaSelect, ElementPicker, RingMarkers, TargetBox } from "./Overlays";
import { readPrefs, writePrefs, type Dock, type ReviewPrefs, type Tab } from "./prefs";
import { RINGS } from "./rings";
import { reviewApi, type Impression, type Note, type ReviewFeature, type Session, type Target, type TaskStatus } from "./reviewApi";
import { ARCHETYPES, PLAYBOOKS } from "./scripts";
import "./review.css";

const IMPRESSIONS: { value: Impression; label: string; Icon: typeof ThumbsUp }[] = [
  { value: "good", label: "Godt", Icon: ThumbsUp },
  { value: "meh", label: "Så som så", Icon: Meh },
  { value: "bad", label: "Dårligt", Icon: ThumbsDown },
];

const STATUS: { value: TaskStatus; label: string }[] = [
  { value: "done", label: "Gennemført" },
  { value: "stuck", label: "Gået i stå" },
  { value: "skipped", label: "Sprunget over" },
];

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const SHORTCUT = isMac ? "⌃⌥⌘W" : "Ctrl+Alt+Shift+W";

function Chip({ ring }: { ring: number | null }) {
  const r = ring ? RINGS[ring] : null;
  return (
    <span className="review-chip" style={r ? { background: r.bg, color: r.ink } : undefined}>
      {ring ? `R${ring}` : "?"}
    </span>
  );
}

export default function ReviewPanel({ onClose }: { onClose: () => void }) {
  const { user } = useAuth();
  const userId = user!.id;
  const ctx = useFeatures();
  const { setPreview } = ctx;
  const { pathname } = useLocation();
  const initial = useMemo<ReviewPrefs>(() => readPrefs(userId), [userId]);

  const [tab, setTab] = useState<Tab>(initial.tab ?? "ring");
  const [dock, setDock] = useState<Dock>(initial.dock ?? "right");
  const [pos, setPos] = useState(initial.pos ?? null);
  const [collapsed, setCollapsed] = useState(!!initial.collapsed);
  const [level, setLevel] = useState<number | null>(initial.level ?? null);
  const [overrides, setOverrides] = useState<Record<string, number>>(initial.overrides ?? {});
  const [markers, setMarkers] = useState(!!initial.markers);
  const [overview, setOverview] = useState(!!initial.overview);
  const [hidden, setHidden] = useState(false);
  const [mode, setMode] = useState<"pick" | "area" | null>(null);
  const [target, setTarget] = useState<{ target: Target; feature: string | null } | null>(null);

  // The preview applies while the panel is open; closing the panel shows the app as it really is.
  useEffect(() => {
    setPreview({ level, overrides, markers });
  }, [level, overrides, markers, setPreview]);
  useEffect(() => () => setPreview(null), [setPreview]);
  useEffect(() => {
    writePrefs(userId, { tab, dock, pos, collapsed, level, overrides, markers, overview });
  }, [userId, tab, dock, pos, collapsed, level, overrides, markers, overview]);

  // Sessions: the running one (if any) collects page visits and notes.
  const [sessions, setSessions] = useState<Session[]>([]);
  const [error, setError] = useState<string | null>(null);
  const loadSessions = useCallback(() => reviewApi.sessions().then(setSessions).catch((e) => setError(errorText(e))), []);
  useEffect(() => { loadSessions(); }, [loadSessions]);
  const active = sessions.find((s) => !s.ended_at) ?? null;
  const [taskId, setTaskId] = useState<string | null>(null);
  useEffect(() => {
    if (active && !active.tasks.some((t) => t.id === taskId)) {
      setTaskId(active.tasks.find((t) => t.status === "open")?.id ?? null);
    }
  }, [active, taskId]);

  const activeId = active?.id;
  useEffect(() => {
    if (!activeId) return;
    reviewApi.visit(activeId, pathname).then(({ pages }) =>
      setSessions((all) => all.map((s) => (s.id === activeId && s.pages.length !== pages
        ? { ...s, pages: [...s.pages, { path: pathname, at: new Date().toISOString() }] } : s))),
    ).catch(() => {});
  }, [activeId, pathname]);

  // Placement: docked left/right, or moved by dragging the header or with the arrow keys.
  const panelRef = useRef<HTMLElement>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const clamp = (x: number, y: number) => {
    const el = panelRef.current;
    const w = el?.offsetWidth ?? 380;
    return { x: Math.max(8, Math.min(window.innerWidth - w - 8, x)), y: Math.max(8, Math.min(window.innerHeight - 48, y)) };
  };
  const onHeadDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as Element).closest("button")) return;
    const rect = panelRef.current!.getBoundingClientRect();
    drag.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onHeadMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current) setPos(clamp(e.clientX - drag.current.dx, e.clientY - drag.current.dy));
  };
  const onHeadKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 24;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const move = moves[e.key];
    if (!move) return;
    e.preventDefault();
    const rect = panelRef.current!.getBoundingClientRect();
    setPos(clamp(rect.left + move[0], rect.top + move[1]));
  };
  const placement = pos ? { left: pos.x, top: pos.y } : dock === "left" ? { left: 16, top: 72 } : { right: 16, top: 72 };

  const view = viewLevel(ctx);
  const setRing = (key: string, ring: number | null) => setOverrides((o) => {
    const next = { ...o };
    if (ring === null || ring === ctx.features?.byKey.get(key)?.ring) delete next[key];
    else next[key] = ring;
    return next;
  });

  const pick = useCallback((t: Target, feature: string | null) => {
    setTarget({ target: t, feature });
    setMode(null);
    setTab("feedback");
  }, []);
  const cancelPick = useCallback(() => setMode(null), []);

  const name = user!.display_name || user!.email || user!.phone || "dig";

  return (
    <div className="review-root" style={{ visibility: hidden ? "hidden" : undefined }}>
      {markers && <RingMarkers ringOf={(k) => effectiveRing(ctx, k)} localKeys={new Set(Object.keys(overrides))} onSetRing={setRing} />}
      {target && !mode && <TargetBox target={target.target} />}
      {mode === "pick" && <ElementPicker onPick={pick} onCancel={cancelPick} />}
      {mode === "area" && <AreaSelect onPick={pick} onCancel={cancelPick} />}

      <section ref={panelRef} className={`review-panel${collapsed ? " collapsed" : ""}`} style={placement}
               aria-label="Review-panel">
        <div className="review-head" onPointerDown={onHeadDown} onPointerMove={onHeadMove}
             onPointerUp={() => { drag.current = null; }} onKeyDown={onHeadKey} tabIndex={0}
             aria-label="Review-panel. Flyt det med piletasterne">
          <strong>Review</strong>
          <Chip ring={view} />
          {active && <span className="review-live" title="Session i gang">● {active.persona.name.split(",")[0]}</span>}
          <span className="review-sp" />
          <button type="button" className="review-icon" aria-label={dock === "right" ? "Læg panelet i venstre side" : "Læg panelet i højre side"}
                  onClick={() => { setDock(dock === "right" ? "left" : "right"); setPos(null); }}>
            {dock === "right" ? <PanelLeft size={16} /> : <PanelRight size={16} />}
          </button>
          <button type="button" className="review-icon" aria-label={collapsed ? "Fold panelet ud" : "Fold panelet sammen"}
                  aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>
            {collapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
          </button>
          <button type="button" className="review-icon" aria-label={`Luk panelet (${SHORTCUT})`} onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {!collapsed && (
          <>
            <div className="review-tabs" role="tablist">
              {([["ring", "Ring"], ["feedback", "Feedback"], ["session", "Session"]] as const).map(([value, label]) => (
                <button key={value} type="button" role="tab" aria-selected={tab === value}
                        className={tab === value ? "on" : ""} onClick={() => setTab(value)}>
                  {label} {value === "ring" && <Chip ring={view} />}
                  {value === "session" && active && <span className="review-dot" aria-label="i gang" />}
                </button>
              ))}
            </div>
            <div className="review-body">
              {error && <p className="review-error" role="alert">{error}</p>}
              {tab === "ring" && (
                <RingTab level={level} setLevel={setLevel} overrides={overrides} clearOverrides={() => setOverrides({})}
                         markers={markers} setMarkers={setMarkers} overview={overview} setOverview={setOverview} />
              )}
              {tab === "feedback" && (
                <FeedbackTab path={pathname} view={view} session={active} taskId={taskId} target={target}
                             clearTarget={() => setTarget(null)} startMode={setMode}
                             hide={async () => { setHidden(true); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); }}
                             show={() => setHidden(false)} onSaved={loadSessions} />
              )}
              {tab === "session" && (
                <SessionTab sessions={sessions} active={active} taskId={taskId} setTaskId={setTaskId} reload={loadSessions}
                            setSessions={setSessions} viewAs={setLevel} />
              )}
            </div>
            <div className="review-foot">
              <span>Gemmes på serveren for {name} · {SHORTCUT} skjuler</span>
              <a href={reviewApi.allZip} download><Download size={14} aria-hidden="true" /> Zip alt</a>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

// ── Ring ────────────────────────────────────────────────────────────────────

function RingTab({ level, setLevel, overrides, clearOverrides, markers, setMarkers, overview, setOverview }: {
  level: number | null; setLevel: (l: number | null) => void;
  overrides: Record<string, number>; clearOverrides: () => void;
  markers: boolean; setMarkers: (v: boolean) => void;
  overview: boolean; setOverview: (v: boolean) => void;
}) {
  const ctx = useFeatures();
  const own = ctx.features?.level ?? 4;
  const view = viewLevel(ctx);
  const gates = useMountedGates();
  const onPage = useMemo(() => {
    const keys = new Map<string, boolean>();
    gates.forEach((g) => keys.set(g.key, (keys.get(g.key) ?? false) || g.enabled));
    return { total: keys.size, shown: [...keys.values()].filter(Boolean).length };
  }, [gates]);
  const local = Object.entries(overrides);

  return (
    <div className="review-stack">
      <p className="review-note">
        Du ser features i ring {view} og derover · {level === null ? "dit eget niveau" : `dit niveau er R${own}`}
      </p>
      <div className="review-stack tight" role="radiogroup" aria-label="Se appen som ring">
        {[1, 2, 3, 4].map((r) => (
          <button key={r} type="button" role="radio" aria-checked={view === r}
                  className={`review-ring${view === r ? " on" : ""}`} onClick={() => setLevel(r === own ? null : r)}>
            <Chip ring={r} /><b>{RINGS[r].name}</b>
            <span className="t">{RINGS[r].text}{r === own ? " Dit eget niveau." : ""}</span>
          </button>
        ))}
      </div>
      <p className="review-note">
        <b>Denne side</b> · {onPage.total ? `${onPage.shown} af ${onPage.total} features vises` : "ingen features markeret her"}
      </p>
      {local.length > 0 && (
        <div className="review-local">
          <span>Ændret i din browser: {local.map(([k, r]) => `${k} → R${r}`).join(", ")}</span>
          <button type="button" className="review-link" onClick={clearOverrides}>Nulstil</button>
        </div>
      )}
      <label className="review-check">
        <input type="checkbox" checked={markers} onChange={(e) => setMarkers(e.target.checked)} /> Vis ring-markører på siden
      </label>
      <label className="review-check">
        <input type="checkbox" checked={overview} onChange={(e) => setOverview(e.target.checked)} /> Vis feature-overblik
      </label>
      {overview && <FeatureOverview view={view} overrides={overrides} />}
      <p className="review-fine">Ringe styrer, hvad appen viser i din browser. De styrer ikke adgang; det gør serveren.</p>
    </div>
  );
}

function FeatureOverview({ view, overrides }: { view: number; overrides: Record<string, number> }) {
  const [items, setItems] = useState<ReviewFeature[] | null>(null);
  const [q, setQ] = useState("");
  const [ring, setRing] = useState(0);
  useEffect(() => { reviewApi.features().then((r) => setItems(r.features)).catch(() => setItems([])); }, []);
  if (!items) return <p className="review-note">Henter features …</p>;
  const needle = q.trim().toLowerCase();
  const shown = items.filter((f) => (!ring || (overrides[f.key] ?? f.ring) === ring)
    && (!needle || `${f.key} ${f.title} ${f.description}`.toLowerCase().includes(needle)));
  return (
    <div className="review-stack tight">
      <div className="review-row">
        <input type="search" placeholder="Søg i features" aria-label="Søg i features" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Filtrér på ring" value={ring} onChange={(e) => setRing(Number(e.target.value))}>
          <option value={0}>Alle ringe</option>
          {[1, 2, 3, 4].map((r) => <option key={r} value={r}>R{r} {RINGS[r].name}</option>)}
        </select>
      </div>
      <ul className="review-list">
        {shown.map((f) => {
          const r = overrides[f.key] ?? f.ring;
          return (
            <li key={f.key} className="review-feature">
              <Chip ring={r} />
              <span className="name"><b>{f.title}</b> <code>{f.key}</code></span>
              <span className={r >= view ? "vis" : "skjult"}>{r >= view ? "vises" : "skjult"}</span>
              <span className="count" title={`Din feedback: ${f.mine}`}>{f.feedback} feedback</span>
            </li>
          );
        })}
        {!shown.length && <li className="review-note">Ingen features passer.</li>}
      </ul>
    </div>
  );
}

// ── Feedback ────────────────────────────────────────────────────────────────

type Pending = { kind: "screenshot" | "audio"; blob: Blob; url: string };

function FeedbackTab({ path, view, session, taskId, target, clearTarget, startMode, hide, show, onSaved }: {
  path: string; view: number; session: Session | null; taskId: string | null;
  target: { target: Target; feature: string | null } | null; clearTarget: () => void;
  startMode: (m: "pick" | "area") => void; hide: () => Promise<void>; show: () => void; onSaved: () => void;
}) {
  const [body, setBody] = useState("");
  const [impression, setImpression] = useState<Impression | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);

  const load = useCallback(() => reviewApi.notes(path).then(setNotes).catch(() => {}), [path]);
  useEffect(() => { load(); }, [load]);

  const add = (kind: Pending["kind"], blob: Blob) => setPending((p) => [...p, { kind, blob, url: URL.createObjectURL(blob) }]);

  const screenshot = async () => {
    setMessage(null);
    try {
      add("screenshot", await captureScreen(target?.target ?? null, hide, show));
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "NotAllowedError")) setMessage({ ok: false, text: errorText(e) });
    }
  };

  const record = async () => {
    setMessage(null);
    if (recording) {
      const blob = await recording.stop();
      setRecording(null);
      if (blob.size) add("audio", blob);
      return;
    }
    try {
      setRecording(await startRecording((text) => setBody((b) => (b ? `${b} ${text}` : text))));
    } catch (e) {
      setMessage({ ok: false, text: e instanceof DOMException && e.name === "NotAllowedError"
        ? "Browseren fik ikke lov til at bruge mikrofonen" : errorText(e) });
    }
  };

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const files = [...pending];
      if (recording) {
        const blob = await recording.stop();
        setRecording(null);
        if (blob.size) files.push({ kind: "audio", blob, url: "" });
      }
      const note = await reviewApi.createNote({
        path, body, impression, feature_key: target?.feature ?? null, ring: view, target: target?.target ?? null,
        session_id: session?.id ?? null, task_id: session ? taskId : null,
      });
      for (const p of files) await reviewApi.attach(note.id, p.kind, p.blob);
      setBody("");
      setImpression(null);
      pending.forEach((p) => URL.revokeObjectURL(p.url));
      setPending([]);
      clearTarget();
      setMessage({ ok: true, text: "Noten er gemt" });
      load();
      onSaved();
    } catch (e) {
      setMessage({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: number) => {
    if (!window.confirm("Slet noten med billeder og lyd?")) return;
    await reviewApi.deleteNote(id).catch((e) => setMessage({ ok: false, text: errorText(e) }));
    load();
  };

  const task = session?.tasks.find((t) => t.id === taskId);
  const empty = !body.trim() && !impression && !target;

  return (
    <div className="review-stack">
      <p className="review-note">
        Skriv, hvad der skal rettes på <code>{path}</code>
        {session && <> · samles i sessionen{task ? <> under »{task.title}«</> : null}</>}
      </p>
      <label className="review-field">
        <span className="sr-only">Note</span>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Hvad skal rettes, og hvorfor?" rows={4} />
      </label>
      <div className="review-row" role="group" aria-label="Indtryk">
        {IMPRESSIONS.map(({ value, label, Icon }) => (
          <button key={value} type="button" aria-pressed={impression === value}
                  className={`review-btn${impression === value ? ` on ${value}` : ""}`}
                  onClick={() => setImpression(impression === value ? null : value)}>
            <Icon size={14} aria-hidden="true" /> {label}
          </button>
        ))}
      </div>
      <div className="review-row">
        <button type="button" className="review-btn" onClick={() => startMode("pick")}>
          <MousePointerClick size={14} aria-hidden="true" /> Peg på element
        </button>
        <button type="button" className="review-btn" onClick={() => startMode("area")}>
          <SquareDashed size={14} aria-hidden="true" /> Markér område
        </button>
        {canCaptureScreen() && (
          <button type="button" className="review-btn" onClick={screenshot}>
            <Camera size={14} aria-hidden="true" /> Billede
          </button>
        )}
        {canRecord() && (
          <button type="button" className={`review-btn${recording ? " on bad" : ""}`} onClick={record} aria-pressed={!!recording}>
            {recording ? <Square size={14} aria-hidden="true" /> : <Mic size={14} aria-hidden="true" />}
            {recording ? (recording.dictating ? "Stop optagelse og diktat" : "Stop optagelse") : "Optag og diktér"}
          </button>
        )}
      </div>
      {target && (
        <div className="review-local">
          <span>
            {target.target.kind === "element"
              ? <>Element <code>{target.target.tag}</code>{target.target.text ? ` »${target.target.text.slice(0, 40)}«` : ""}</>
              : <>Område {target.target.w}×{target.target.h} px</>}
            {target.feature ? <> · feature <code>{target.feature}</code></> : null}
          </span>
          <button type="button" className="review-link" onClick={clearTarget}>Fjern</button>
        </div>
      )}
      {pending.length > 0 && (
        <div className="review-attachments">
          {pending.map((p, i) => (
            <div key={i} className="review-attachment">
              {p.kind === "screenshot" ? <img src={p.url} alt="Skærmbillede til noten" /> : <audio src={p.url} controls />}
              <button type="button" className="review-icon" aria-label="Fjern vedhæftning"
                      onClick={() => setPending((all) => all.filter((_, j) => j !== i))}><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
      )}
      <button type="button" className="review-btn primary" disabled={busy || (empty && !pending.length)} onClick={save}>
        {busy ? "Gemmer …" : "Gem note"}
      </button>
      {message && <p className={message.ok ? "review-ok" : "review-error"} role="status">{message.text}</p>}

      {notes.length > 0 && (
        <>
          <h3 className="review-h">Dine noter på denne side ({notes.length})</h3>
          <ul className="review-list">
            {notes.map((n) => (
              <li key={n.id} className="review-item">
                <div className="review-row between">
                  <span className="review-meta">
                    {new Date(n.created_at).toLocaleString("da-DK", { dateStyle: "short", timeStyle: "short" })}
                    {n.impression && <> · {IMPRESSIONS.find((i) => i.value === n.impression)?.label}</>}
                    {n.feature_key && <> · <code>{n.feature_key}</code></>}
                    {n.ring && <> · <Chip ring={n.ring} /></>}
                  </span>
                  <button type="button" className="review-icon" aria-label="Slet noten" onClick={() => remove(n.id)}><Trash2 size={14} /></button>
                </div>
                {n.body && <p>{n.body}</p>}
                {n.attachments.length > 0 && (
                  <div className="review-attachments">
                    {n.attachments.map((a) => a.kind === "screenshot"
                      ? <a key={a.id} href={a.url} target="_blank" rel="noreferrer"><img src={a.url} alt="Skærmbillede" /></a>
                      : <audio key={a.id} src={a.url} controls preload="none" />)}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

// ── Session ─────────────────────────────────────────────────────────────────

function SessionTab({ sessions, active, taskId, setTaskId, reload, setSessions, viewAs }: {
  sessions: Session[]; active: Session | null; taskId: string | null; setTaskId: (id: string) => void;
  reload: () => void; setSessions: (s: Session[]) => void; viewAs: (level: number | null) => void;
}) {
  const navigate = useNavigate();
  const [persona, setPersona] = useState(ARCHETYPES[0]?.key ?? "");
  const books = PLAYBOOKS.filter((p) => p.archetype === persona);
  const [book, setBook] = useState<string>(books[0]?.key ?? "");
  const [asCustomer, setAsCustomer] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setBook(PLAYBOOKS.find((p) => p.archetype === persona)?.key ?? ""); }, [persona]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };

  const start = () => run(async () => {
    const a = ARCHETYPES.find((x) => x.key === persona)!;
    const b = PLAYBOOKS.find((x) => x.key === book);
    await reviewApi.startSession({
      persona_key: a.key, persona: { name: a.name, who: a.who, wants: a.wants, worries: a.worries, ring: a.ring },
      script_key: b?.key ?? "", script_title: b?.title ?? "", ring: asCustomer ? a.ring : null, tasks: b?.tasks ?? [],
    });
    if (asCustomer) viewAs(a.ring);
    reload();
    if (b?.start) navigate(b.start);
  });

  const setStatus = (s: Session, id: string, status: TaskStatus) => run(async () => {
    const current = s.tasks.find((t) => t.id === id)?.status;
    const updated = await reviewApi.updateSession(s.id, { tasks: [{ id, status: current === status ? "open" : status }] });
    setSessions(sessions.map((x) => (x.id === s.id ? updated : x)));
  });

  const end = (s: Session) => run(async () => {
    const updated = await reviewApi.updateSession(s.id, { end: true });
    setSessions(sessions.map((x) => (x.id === s.id ? updated : x)));
  });

  const remove = (s: Session) => {
    if (!window.confirm("Slet sessionen med alle dens noter, billeder og lyd?")) return;
    run(async () => { await reviewApi.deleteSession(s.id); reload(); });
  };

  const past = sessions.filter((s) => s.ended_at);
  const a = ARCHETYPES.find((x) => x.key === persona);

  return (
    <div className="review-stack">
      {error && <p className="review-error" role="alert">{error}</p>}
      {active ? (
        <div className="review-stack">
          <div className="review-card">
            <div className="review-row between">
              <b>{active.persona.name}</b>
              {active.ring && <Chip ring={active.ring} />}
            </div>
            <span className="review-meta">{active.script_title || "Fri gennemgang"} · {active.pages.length} sider · {active.feedback} noter</span>
            {active.persona.who && <p className="review-note"><b>Hvem:</b> {active.persona.who}</p>}
            {active.persona.wants && <p className="review-note"><b>Vil:</b> {active.persona.wants}</p>}
            {active.persona.worries && <p className="review-note"><b>Bekymret for:</b> {active.persona.worries}</p>}
            {active.ring && (
              <button type="button" className="review-btn" onClick={() => viewAs(active.ring)}>Se appen som kunden (R{active.ring})</button>
            )}
          </div>
          {active.tasks.length > 0 && (
            <ol className="review-tasks">
              {active.tasks.map((t) => (
                <li key={t.id} className={`review-task ${t.status}`}>
                  <label className="review-check">
                    <input type="radio" name="review-task" checked={taskId === t.id} onChange={() => setTaskId(t.id)} />
                    <span>{t.title}</span>
                  </label>
                  <div className="review-row">
                    {STATUS.map((s) => (
                      <button key={s.value} type="button" disabled={busy} aria-pressed={t.status === s.value}
                              className={`review-btn sm${t.status === s.value ? ` on ${s.value}` : ""}`}
                              onClick={() => setStatus(active, t.id, s.value)}>
                        {s.label}
                      </button>
                    ))}
                  </div>
                </li>
              ))}
            </ol>
          )}
          <p className="review-fine">Noter i fanen Feedback knyttes til den valgte opgave. Sider, du besøger, samles i sessionen.</p>
          <button type="button" className="review-btn primary" disabled={busy} onClick={() => end(active)}>Afslut session</button>
        </div>
      ) : (
        <div className="review-stack">
          <p className="review-note">Gennemgå appen som en bestemt kunde. Sidebesøg og feedback samles i sessionen.</p>
          <label className="review-field">
            Arketype
            <select value={persona} onChange={(e) => setPersona(e.target.value)}>
              {ARCHETYPES.map((x) => <option key={x.key} value={x.key}>{x.name}</option>)}
            </select>
          </label>
          {a && (
            <div className="review-card">
              <p className="review-note"><b>Hvem:</b> {a.who}</p>
              <p className="review-note"><b>Vil:</b> {a.wants}</p>
              <p className="review-note"><b>Bekymret for:</b> {a.worries}</p>
            </div>
          )}
          <label className="review-field">
            Drejebog
            <select value={book} onChange={(e) => setBook(e.target.value)}>
              {books.map((b) => <option key={b.key} value={b.key}>{b.title}</option>)}
              <option value="">Fri gennemgang</option>
            </select>
          </label>
          {a && (
            <label className="review-check">
              <input type="checkbox" checked={asCustomer} onChange={(e) => setAsCustomer(e.target.checked)} />
              Se appen som kunden (R{a.ring} {RINGS[a.ring].name})
            </label>
          )}
          <button type="button" className="review-btn primary" disabled={busy || !a} onClick={start}>Start session</button>
        </div>
      )}

      {past.length > 0 && (
        <>
          <h3 className="review-h">Tidligere sessioner</h3>
          <ul className="review-list">
            {past.map((s) => (
              <li key={s.id} className="review-item">
                <div className="review-row between">
                  <b>{s.persona.name}</b>
                  <span className="review-meta">{new Date(s.started_at).toLocaleDateString("da-DK")}</span>
                </div>
                <span className="review-meta">
                  {s.script_title || "Fri gennemgang"} · {s.tasks.filter((t) => t.status === "done").length}/{s.tasks.length} opgaver
                  · {s.feedback} noter · {s.pages.length} sider
                </span>
                <div className="review-row">
                  <a className="review-btn sm" href={reviewApi.sessionZip(s.id)} download><Download size={13} aria-hidden="true" /> Zip</a>
                  <button type="button" className="review-btn sm danger" disabled={busy} onClick={() => remove(s)}>
                    <Trash2 size={13} aria-hidden="true" /> Slet
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
