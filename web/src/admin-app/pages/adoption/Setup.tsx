// /admin/adoption/journeys/:id/setup → Opsætning: name, status, audience, goal and period, the steps, the "Tilføj målepunkt"
// form with a live preview of which tracked routes the pattern catches, the journey's roles and deleting it.
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { api, errorText } from "../../../api";
import { Btn, IconBtn, useLoad, useToast } from "../../ui";
import { card, fmt, input, label, MONO, select } from "../../theme";
import { MATCH_LABEL, MATCH_TYPES, toRegExp, type MatchType } from "./match";
import { Bar, Code, pct, Seg, STATUS, useAdoption, type Audience, type Journey, type Status, type Step } from "./shared";

const NEXT: Record<Status, Status> = { draft: "active", active: "paused", paused: "active" };
const NEXT_LABEL: Record<Status, string> = { draft: "Start forløbet", active: "Sæt på pause", paused: "Genoptag" };
const ROLE_NAMES = { reader: "Læser", editor: "Redaktør", owner: "Ejer" } as const;

const dateInput = (iso: string | null) => (iso ? iso.slice(0, 10) : "");
const fromDate = (v: string) => (v ? new Date(`${v}T00:00:00`).toISOString() : null);

export default function JourneySetup({ journey }: { journey: Journey }) {
  const { reloadJourneys, draft, setDraft } = useAdoption();
  const say = useToast();
  const [name, setName] = useState(journey.name);

  const save = async (patch: Record<string, unknown>, done?: string) => {
    try {
      await api.patch(`/api/admin/adoption/journeys/${journey.id}`, patch);
      await reloadJourneys();
      if (done) say(done);
      return true;
    } catch (e) {
      say(errorText(e));
      return false;
    }
  };
  const steps: Step[] = journey.steps.map(({ label: l, match_type, pattern }) => ({ label: l, match_type, pattern }));
  const saveSteps = (next: Step[], done?: string) => save({ steps: next }, done);
  const move = (i: number, by: number) => {
    const next = [...steps];
    [next[i], next[i + by]] = [next[i + by]!, next[i]!];
    saveSteps(next);
  };

  const n = journey.steps.length;
  const last = n ? journey.reached[n - 1] ?? 0 : 0;
  const worst = journey.steps.slice(1).reduce<{ conv: number; text: string } | null>((w, s, k) => {
    const conv = pct(journey.reached[k + 1] ?? 0, journey.reached[k] ?? 0);
    return !w || conv < w.conv ? { conv, text: `${journey.steps[k]!.label} → ${s.label}` } : w;
  }, null);

  return (
    <>
      {journey.can_edit && (
        <section style={{ ...card, display: "flex", flexDirection: "column", gap: 18, padding: 22 }}>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 16 }}>
            <label style={{ ...label, flex: "1 1 260px" }}>Navn på forløb
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120}
                onBlur={() => { const v = name.trim(); if (v && v !== journey.name) save({ name: v }); else setName(journey.name); }}
                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                style={{ ...input, height: 42, fontSize: 20, fontWeight: 700 }} />
            </label>
            <span style={{ padding: "4px 10px", borderRadius: 9999, fontSize: 12, fontWeight: 600, ...STATUS[journey.status][1] }}>{STATUS[journey.status][0]}</span>
            <Btn kind={journey.status === "active" ? "outline" : "primary"} disabled={journey.status === "draft" && n === 0}
              title={journey.status === "draft" && n === 0 ? "Tilføj mindst ét trin først" : undefined}
              onClick={() => save({ status: NEXT[journey.status] }, `${STATUS[NEXT[journey.status]][0]}`)}>
              {NEXT_LABEL[journey.status]}
            </Btn>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
            <AudienceEditor audience={journey.audience} onSave={(a) => save({ audience: a }, "Målgruppen er gemt")} />
            <label style={label}>Mål (%)
              <input type="number" min={1} max={100} defaultValue={journey.goal_pct} style={input}
                onBlur={(e) => { const v = Math.round(Number(e.target.value)); if (v >= 1 && v <= 100 && v !== journey.goal_pct) save({ goal_pct: v }); }} />
            </label>
            <label style={label}>Start
              <input type="date" defaultValue={dateInput(journey.start_at)} style={input}
                onBlur={(e) => { const v = fromDate(e.target.value); if (v && v.slice(0, 10) !== journey.start_at.slice(0, 10)) save({ start_at: v }); }} />
            </label>
            <label style={label}>Slut (valgfri)
              <input type="date" defaultValue={dateInput(journey.end_at)} style={input}
                onBlur={(e) => { const v = fromDate(e.target.value); if (v?.slice(0, 10) !== journey.end_at?.slice(0, 10)) save({ end_at: v }); }} />
            </label>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
            <Stat label="Målgruppe" value={fmt(journey.cohort_size)} />
            <Stat label="Gennemført" value={`${fmt(last)} · ${journey.done_pct} %`} />
            <Stat label="Mål" value={`${journey.goal_pct} %`} good={n > 0 && journey.done_pct >= journey.goal_pct} />
            <Stat label="Største frafald" value={worst ? `${worst.text} (${worst.conv} %)` : "—"} small />
          </div>

          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", justifyContent: "space-between", gap: 8, paddingBottom: 8, borderBottom: "1px solid #e2e8f0" }}>
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Trin og målepunkter</h3>
              <span style={{ fontSize: 12, color: "#64748b" }}>Et trin er nået, når brugeren har besøgt en side der matcher — i rækkefølge</span>
            </div>
            {n === 0 && <p style={{ margin: 0, padding: "20px 0", fontSize: 14, color: "#64748b" }}>Ingen trin endnu. Tilføj det første målepunkt herunder — fx den side brugerne lander på første gang.</p>}
            {journey.steps.map((s, i) => {
              const reached = journey.reached[i] ?? 0;
              const prev = i === 0 ? journey.cohort_size : journey.reached[i - 1] ?? 0;
              return (
                <div key={s.id ?? i} style={{ display: "grid", gridTemplateColumns: "32px minmax(0,1.4fr) minmax(0,1fr) 72px 70px 104px", alignItems: "center",
                  gap: 14, padding: "10px 0", borderBottom: "1px solid #e2e8f0" }}>
                  <span style={{ width: 28, height: 28, borderRadius: 9999, background: "rgba(37,99,235,0.12)", color: "#1d4ed8", fontSize: 12, fontWeight: 700,
                    display: "flex", alignItems: "center", justifyContent: "center" }}>{i + 1}</span>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
                    <b style={{ fontSize: 14, fontWeight: 600 }}>{s.label}</b>
                    <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                      <span style={{ padding: "1px 6px", borderRadius: 9999, background: "#f1f5f9", fontSize: 10, fontWeight: 600, textTransform: "uppercase",
                        letterSpacing: "0.05em", color: "#475569", whiteSpace: "nowrap" }}>{MATCH_LABEL[s.match_type]}</span>
                      <Code style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.pattern}</Code>
                    </span>
                  </div>
                  <Bar value={Math.max(1, pct(reached, journey.cohort_size))} height={10} />
                  <span style={{ display: "flex", flexDirection: "column", textAlign: "right" }}>
                    <b style={{ fontSize: 14, fontVariantNumeric: "tabular-nums" }}>{fmt(reached)}</b>
                    <span style={{ fontSize: 11, color: "#64748b" }}>{pct(reached, journey.cohort_size)} %</span>
                  </span>
                  <span style={{ fontSize: 12, color: "#64748b", textAlign: "right" }}>{i === 0 ? "fra start" : `${pct(reached, prev)} % videre`}</span>
                  <span style={{ display: "flex", justifyContent: "flex-end" }}>
                    {i > 0 && <IconBtn icon={ArrowUp} label={`Flyt trin ${i + 1} op`} onClick={() => move(i, -1)} />}
                    {i < n - 1 && <IconBtn icon={ArrowDown} label={`Flyt trin ${i + 1} ned`} onClick={() => move(i, 1)} />}
                    <IconBtn icon={X} label={`Fjern trin ${i + 1}`} onClick={() => {
                      if (confirm(`Fjern trinnet »${s.label}«? Tragten regnes om med de øvrige trin.`)) saveSteps(steps.filter((_, k) => k !== i), "Trinnet er fjernet");
                    }} />
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {journey.can_edit && (
        <AddStep key={draft ? `${draft.match_type}:${draft.pattern}` : "new"} count={n}
          initial={draft} onAdd={async (s) => { const ok = await saveSteps([...steps, s], "Trinnet er tilføjet"); if (ok) setDraft(null); return ok; }} />
      )}
      <Members journey={journey} />
    </>
  );
}

function Stat({ label: l, value, good, small }: { label: string; value: string; good?: boolean; small?: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: "12px 14px", borderRadius: 12, background: "#f1f5f9" }}>
      <span style={{ fontSize: 12, color: "#475569" }}>{l}</span>
      <b style={{ fontSize: small ? 15 : 20, lineHeight: 1.35, color: good ? "#16a34a" : undefined, fontVariantNumeric: "tabular-nums" }}>{value}</b>
    </div>
  );
}

function AudienceEditor({ audience, onSave }: { audience: Audience; onSave: (a: Audience) => void }) {
  const [kind, setKind] = useState(audience.kind);
  const roles = audience.kind === "role" ? audience.roles : [];
  const ids = audience.kind === "users" ? audience.user_ids : [];
  const [q, setQ] = useState("");
  const people = useLoad(() => (kind === "users"
    ? api.get<{ items: { id: number; display_name: string; role: string }[] }>(`/api/admin/adoption/people?q=${encodeURIComponent(q)}`)
    : Promise.resolve({ items: [] })), [kind, q]);

  const toggleRole = (r: "user" | "admin") => {
    const next = roles.includes(r) ? roles.filter((x) => x !== r) : [...roles, r];
    if (next.length) onSave({ kind: "role", roles: next });
  };
  const toggleUser = (id: number) => {
    const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
    if (next.length) onSave({ kind: "users", user_ids: next });
  };

  return (
    <div style={{ gridColumn: "1 / -1", display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 12 }}>
      <label style={{ ...label, flex: "0 1 240px" }}>Målgruppe
        <select value={kind} style={select} onChange={(e) => {
          const k = e.target.value as Audience["kind"];
          setKind(k);
          if (k === "all") onSave({ kind: "all" });
          if (k === "role") onSave({ kind: "role", roles: ["user"] });
        }}>
          <option value="all">Alle sporede brugere</option>
          <option value="role">Rolle (også dem uden besøg)</option>
          <option value="users">Udvalgte brugere</option>
        </select>
      </label>
      {kind === "role" && (
        <fieldset style={{ border: 0, margin: 0, padding: 0, display: "flex", gap: 14, alignItems: "center", height: 36 }}>
          <legend style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>Roller</legend>
          {(["user", "admin"] as const).map((r) => (
            <label key={r} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14 }}>
              <input type="checkbox" checked={roles.includes(r)} onChange={() => toggleRole(r)} />{r === "user" ? "Bruger" : "Admin"}
            </label>
          ))}
        </fieldset>
      )}
      {kind === "users" && (
        <div style={{ flex: "1 1 320px", display: "flex", flexDirection: "column", gap: 8 }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Søg på navn" aria-label="Søg brugere" style={input} />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {(people.data?.items ?? []).map((p) => {
              const on = ids.includes(p.id);
              return (
                <button key={p.id} type="button" aria-pressed={on} onClick={() => toggleUser(p.id)}
                  style={{ padding: "4px 10px", borderRadius: 9999, cursor: "pointer", fontSize: 12, border: `1px solid ${on ? "#2563eb" : "#e2e8f0"}`,
                    background: on ? "rgba(37,99,235,0.1)" : "#ffffff", color: on ? "#1d4ed8" : "#020817" }}>
                  {on ? "✓ " : ""}{p.display_name}
                </button>
              );
            })}
          </div>
          <span style={{ fontSize: 12, color: "#64748b" }}>{ids.length} valgt</span>
        </div>
      )}
    </div>
  );
}

function AddStep({ count, initial, onAdd }: { count: number; initial: { label: string; match_type: MatchType; pattern: string } | null;
  onAdd: (s: Step) => Promise<boolean> }) {
  const [stepLabel, setStepLabel] = useState(initial?.label ?? "");
  const [type, setType] = useState<MatchType>(initial?.match_type ?? "exact");
  const [pattern, setPattern] = useState(initial?.pattern ?? "");
  const { data } = useLoad(() => api.get<{ rows: { route: string; visits: number }[] }>("/api/admin/adoption/routes?days=90"), []);
  const info = MATCH_TYPES.find((m) => m.value === type)!;
  const rx = toRegExp(type, pattern);
  const empty = !pattern.trim();
  const matched = rx ? (data?.rows ?? []).filter((r) => rx.test(r.route)) : [];
  const title = empty ? "Skriv en sti for at se, hvilke sporede ruter trinnet fanger"
    : !rx ? "Ugyldigt udtryk"
      : matched.length ? `Matcher ${matched.length} ${matched.length === 1 ? "rute" : "ruter"} · ${fmt(matched.reduce((a, r) => a + r.visits, 0))} besøg på 90 d`
        : "Matcher ingen sporede ruter endnu — trinnet måles fra første besøg";
  useEffect(() => { if (initial) document.getElementById("adoption-add-step")?.scrollIntoView({ behavior: "smooth" }); }, [initial]);

  const add = async () => {
    if (empty || !rx) return;
    if (await onAdd({ label: stepLabel.trim() || `Trin ${count + 1}`, match_type: type, pattern: pattern.trim() })) {
      setStepLabel("");
      setPattern("");
    }
  };

  return (
    <section id="adoption-add-step" style={{ ...card, borderColor: "rgba(37,99,235,0.2)", display: "flex", flexDirection: "column", gap: 14, padding: 22 }}>
      <div>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Tilføj målepunkt</h3>
        <p style={{ margin: "2px 0 0", fontSize: 13, color: "#64748b" }}>Vælg hvordan stien matches — forhåndsvisningen viser hvilke sporede ruter trinnet fanger</p>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
        <label style={label}>Navn på trin
          <input value={stepLabel} onChange={(e) => setStepLabel(e.target.value)} placeholder={`Trin ${count + 1}`} maxLength={120} style={input} />
        </label>
        <div style={label}>
          <span id="adoption-match-type">Sådan matches stien</span>
          <Seg<MatchType> label="Sådan matches stien" value={type} onChange={setType} options={MATCH_TYPES.map((m) => ({ value: m.value, label: m.label }))} />
        </div>
      </div>
      <label style={label}>Sti eller mønster
        <input value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder={info.example} maxLength={300}
          onKeyDown={(e) => e.key === "Enter" && add()} style={{ ...input, height: 40, fontFamily: MONO }} />
        <span style={{ fontWeight: 400, fontSize: 12, color: "#64748b" }}>{info.hint}</span>
      </label>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "14px 16px", borderRadius: 12, background: "#f8fafc", border: "1px solid #e2e8f0" }}>
        <b style={{ fontSize: 13, color: !empty && !rx ? "#dc2626" : matched.length ? "#166534" : "#64748b" }}>{title}</b>
        {matched.length > 0 && (
          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 4 }}>
            {matched.slice(0, 8).map((r) => (
              <li key={r.route} style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 12 }}>
                <Code>{r.route}</Code><span style={{ color: "#64748b", fontVariantNumeric: "tabular-nums" }}>{fmt(r.visits)} besøg</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div><Btn kind="primary" disabled={empty || !rx} onClick={add}>Tilføj trin</Btn></div>
    </section>
  );
}

type Member = { user_id: number; role: keyof typeof ROLE_NAMES; display_name: string | null; added_by: string | null; created_at: string };

function Members({ journey }: { journey: Journey }) {
  const { data, reload } = useLoad(() => api.get<{ items: Member[]; candidates: { id: number; display_name: string }[]; can_manage: boolean }>(
    `/api/admin/adoption/journeys/${journey.id}/members`), [journey.id]);
  const { reloadJourneys, select: selectJourney } = useAdoption();
  const navigate = useNavigate();
  const say = useToast();
  const [who, setWho] = useState("");
  const [role, setRole] = useState<Member["role"]>("reader");
  const manage = data?.can_manage ?? false;

  const run = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      say(done);
      await reload();
    } catch (e) {
      say(errorText(e));
    }
  };
  const remove = async () => {
    if (!confirm(`Slet forløbet »${journey.name}« og alle dets trin? Besøgsdata bevares til andre forløb.`)) return;
    try {
      await api.del(`/api/admin/adoption/journeys/${journey.id}`);
      say("Forløbet er slettet");
      await reloadJourneys();
      selectJourney(0);
      navigate("/adoption");
    } catch (e) {
      say(errorText(e));
    }
  };

  return (
    <section style={{ ...card, display: "flex", flexDirection: "column", gap: 14, padding: 22 }}>
      <div>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Roller i forløbet</h3>
        <p style={{ margin: "2px 0 0", fontSize: 13, color: "#64748b" }}>
          Læser ser statistik · Redaktør ændrer opsætning og sender skub · Ejer styrer roller og kan slette. Admins med Fuld adgang ser alle forløb.
        </p>
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        {(data?.items ?? []).map((m) => (
          <div key={m.user_id} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 160px 40px", alignItems: "center", gap: 12, padding: "8px 0", borderBottom: "1px solid #e2e8f0", fontSize: 13 }}>
            <span style={{ display: "flex", flexDirection: "column" }}>
              <b style={{ fontWeight: 500 }}>{m.display_name ?? `Bruger ${m.user_id}`}</b>
              <span style={{ fontSize: 12, color: "#64748b" }}>{m.added_by ? `Tilføjet af ${m.added_by}` : "Oprettede forløbet"}</span>
            </span>
            {manage ? (
              <select value={m.role} aria-label={`Rolle for ${m.display_name ?? m.user_id}`} style={select}
                onChange={(e) => run(() => api.put(`/api/admin/adoption/journeys/${journey.id}/members/${m.user_id}`, { role: e.target.value }), "Rollen er gemt")}>
                {Object.entries(ROLE_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            ) : <span>{ROLE_NAMES[m.role]}</span>}
            {manage && <IconBtn icon={X} label={`Fjern ${m.display_name ?? m.user_id}`}
              onClick={() => run(() => api.del(`/api/admin/adoption/journeys/${journey.id}/members/${m.user_id}`), "Rollen er fjernet")} />}
          </div>
        ))}
      </div>
      {manage && (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 10 }}>
          <label style={{ ...label, flex: "1 1 220px" }}>Tilføj admin
            <select value={who} onChange={(e) => setWho(e.target.value)} style={select}>
              <option value="">{data?.candidates.length ? "Vælg en admin med adgang til Adoption …" : "Ingen flere admins med adgang"}</option>
              {data?.candidates.map((c) => <option key={c.id} value={c.id}>{c.display_name}</option>)}
            </select>
          </label>
          <label style={{ ...label, flex: "0 1 160px" }}>Rolle
            <select value={role} onChange={(e) => setRole(e.target.value as Member["role"])} style={select}>
              {Object.entries(ROLE_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <Btn kind="primary" disabled={!who} onClick={() => run(async () => {
            await api.put(`/api/admin/adoption/journeys/${journey.id}/members/${who}`, { role });
            setWho("");
          }, "Rollen er gemt")}>Tilføj</Btn>
        </div>
      )}
      {manage && (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "14px 16px",
          borderRadius: 12, background: "#fef2f2", border: "1px solid rgba(239,68,68,0.3)" }}>
          <span style={{ fontSize: 13, color: "#7f1d1d" }}>Slet forløbet og alle dets trin. Besøgsdata bevares til andre forløb. Handlingen logges i audit-loggen.</span>
          <Btn style={{ background: "#dc2626", color: "#ffffff", border: 0 }} onClick={remove}>Slet forløb</Btn>
        </div>
      )}
    </section>
  );
}
