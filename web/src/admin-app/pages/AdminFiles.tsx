// /admin/files: the file tree. Every user has a home under /users/<id>/, and /shared/ holds common project files
// that the app, the AI chat and the MCP servers use. Rules and audit: server/app/filetree.py.
// Deep links: /admin/files?folder=/shared/projekt/ (from /mcp/admin).
import { useEffect, useRef, useState, type CSSProperties, type DragEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { ChevronRight, Download, File as FileIcon, FileText, Folder, FolderPlus, Home, Image as ImageIcon, Pencil, Trash2, Upload, Users } from "lucide-react";
import { api, errorText } from "../../api";
import { card, MONO } from "../theme";
import { Btn, CloseBtn, Empty, ErrorBox, fmtBytes, fmtDate, fmtNumber, Modal, PageTitle, Pill, download, useLoad, useToast } from "../ui";

type Entry = { name: string; path: string; label: string; files: number; bytes: number; user_id?: number };
type TreeFile = {
  id: string; filename: string; path: string; content_type: string; size_bytes: number; created_at: string; updated_at: string | null;
  preview: "image" | "pdf" | "text" | null; uploaded_by_name?: string | null;
};
type Totals = { files: number; bytes: number; shared_files: number; shared_bytes: number; home_files: number; home_bytes: number; system_files: number };
type Listing = {
  path: string; parent: string | null; kind: "root" | "users" | "home" | "shared"; can_write: boolean;
  folders: Entry[]; files: TreeFile[]; home?: { user_id: number; label: string }; totals: Totals;
};
type Item = TreeFile & { text?: string; truncated?: boolean; kind: string };

const BASE = "/api/admin/files";
const cell: CSSProperties = { padding: "10px 12px", borderTop: "1px solid #f1f5f9", textAlign: "left", verticalAlign: "middle" };
const head: CSSProperties = { padding: "8px 12px", fontSize: 12, fontWeight: 500, color: "#64748b", textAlign: "left" };

function crumbs(listing: Listing): { label: string; path: string }[] {
  const out = [{ label: "/", path: "/" }];
  const parts = listing.path.split("/").filter(Boolean);
  parts.forEach((p, i) => {
    const path = "/" + parts.slice(0, i + 1).join("/") + "/";
    const label = listing.kind === "home" && i === 1 && listing.home ? listing.home.label : p;
    out.push({ label, path });
  });
  return out;
}

function TypeIcon({ f }: { f: TreeFile }) {
  const Icon = f.preview === "image" ? ImageIcon : f.preview === "text" || f.preview === "pdf" ? FileText : FileIcon;
  return <Icon size={16} strokeWidth={2} color="#64748b" aria-hidden="true" />;
}

export default function AdminFiles() {
  const [params, setParams] = useSearchParams();
  const path = params.get("folder") || "/";
  const [q, setQ] = useState("");
  const listing = useLoad(() => api.get<Listing>(`${BASE}/tree?path=${encodeURIComponent(path)}${q ? `&q=${encodeURIComponent(q)}` : ""}`), [path, q]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const say = useToast();
  const data = listing.data;

  useEffect(() => setSelected(null), [path]);

  const go = (to: string) => setParams(to === "/" ? {} : { folder: to });

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setError(null);
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const upload = (files: FileList | File[] | null) => act("Uploader …", async () => {
    const list = Array.from(files ?? []);
    for (const f of list) {
      const form = new FormData();
      form.append("file", f);
      await api.post(`${BASE}/upload?path=${encodeURIComponent(path)}`, form);
    }
    if (input.current) input.current.value = "";
    await listing.reload();
    if (list.length) say(list.length === 1 ? `${list[0].name} er uploadet` : `${list.length} filer er uploadet`);
  });

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (data?.can_write) upload(e.dataTransfer.files);
  };

  const deleteFolder = () => data && act("Sletter …", async () => {
    const n = data.folders.reduce((s, f) => s + f.files, 0) + data.files.length;
    if (!confirm(`Slet mappen ${data.path} med alt indhold${n ? ` (mindst ${n} filer)` : ""}? Det kan ikke fortrydes.`)) return;
    await api.del(`${BASE}/folders?path=${encodeURIComponent(data.path)}`);
    say(`${data.path} er slettet`);
    go(data.parent ?? "/");
  });

  const totals = data?.totals;
  const inSpaceRoot = data && (data.kind === "home" || data.kind === "shared") && data.path.split("/").filter(Boolean).length === (data.kind === "home" ? 2 : 1);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <PageTitle title="Filer" icon={<Folder size={24} strokeWidth={2} />}>
        Hver bruger har sit eget hjem under /users. /shared er fælles projektfiler, som også AI-chatten og MCP kan læse og gemme.
      </PageTitle>

      {totals && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12 }}>
          {([["Filer i alt", fmtNumber(totals.files), fmtBytes(totals.bytes)],
            ["Brugernes hjem", fmtNumber(totals.home_files), fmtBytes(totals.home_bytes)],
            ["/shared", fmtNumber(totals.shared_files), fmtBytes(totals.shared_bytes)],
            ["System (profilbilleder, logo, review)", fmtNumber(totals.system_files), ""]] as const).map(([label, n, b]) => (
            <div key={label} style={{ ...card, padding: "12px 16px", display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontSize: 12, color: "#64748b" }}>{label}</span>
              <span style={{ fontSize: 22, fontWeight: 700 }}>{n}</span>
              {b && <span style={{ fontSize: 12, color: "#64748b" }}>{b}</span>}
            </div>
          ))}
        </div>
      )}

      {(error || listing.error) && <ErrorBox>{error || listing.error}</ErrorBox>}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-start" }}>
        <nav aria-label="Mapper" style={{ ...card, flex: "1 1 200px", maxWidth: 260, padding: 8, display: "flex", flexDirection: "column", gap: 2 }}>
          {([["/", "Alle", Folder], ["/users/", "Brugere", Users], ["/shared/", "Fælles (/shared)", Home]] as const).map(([p, label, Icon]) => {
            const on = p === "/" ? path === "/" : path.startsWith(p);
            return (
              <button key={p} type="button" onClick={() => go(p)} className={on ? undefined : "tg-hover"}
                style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 40, padding: "0 10px", border: 0, borderRadius: 8, cursor: "pointer",
                  font: "inherit", textAlign: "left", background: on ? "#eff6ff" : "transparent", color: on ? "#1d4ed8" : "#020817", fontWeight: on ? 600 : 400 }}>
                <Icon size={16} strokeWidth={2} aria-hidden="true" />{label}
              </button>
            );
          })}
        </nav>

        <section data-deeplink="files-browser" onDragOver={(e) => { e.preventDefault(); if (data?.can_write) setDragging(true); }}
          onDragLeave={() => setDragging(false)} onDrop={onDrop}
          style={{ ...card, flex: "999 1 520px", minWidth: 0, display: "flex", flexDirection: "column",
            outline: dragging ? "2px dashed #2563eb" : undefined, outlineOffset: -4 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", justifyContent: "space-between", padding: "12px 14px", borderBottom: "1px solid #e2e8f0" }}>
            <ol aria-label="Sti" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 2, listStyle: "none", margin: 0, padding: 0, fontFamily: MONO, fontSize: 13 }}>
              {data && crumbs(data).map((c, i, all) => (
                <li key={c.path} style={{ display: "flex", alignItems: "center", gap: 2 }}>
                  {i > 0 && <ChevronRight size={14} color="#94a3b8" aria-hidden="true" />}
                  {i === all.length - 1 ? <strong>{c.label}</strong> : (
                    <button type="button" onClick={() => go(c.path)} className="tg-hover"
                      style={{ border: 0, background: "transparent", color: "#2563eb", cursor: "pointer", font: "inherit", padding: "4px 6px", borderRadius: 6 }}>{c.label}</button>
                  )}
                </li>
              ))}
            </ol>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {data?.kind === "users" && (
                <input type="search" aria-label="Søg bruger" placeholder="Søg navn eller e-mail" value={q} onChange={(e) => setQ(e.target.value)}
                  style={{ height: 36, padding: "0 10px", border: "1px solid #e2e8f0", borderRadius: 8, font: "inherit" }} />
              )}
              {data?.can_write && <>
                <Btn icon={FolderPlus} onClick={() => setNewFolder("")}>Ny mappe</Btn>
                <Btn kind="primary" icon={Upload} onClick={() => input.current?.click()} disabled={!!busy}>{busy ?? "Upload"}</Btn>
                <input ref={input} type="file" multiple hidden onChange={(e) => upload(e.target.files)} />
              </>}
              {data?.can_write && !inSpaceRoot && <Btn icon={Trash2} onClick={deleteFolder} style={{ color: "#b91c1c" }}>Slet mappe</Btn>}
            </div>
          </div>

          {data?.can_write && (
            <p style={{ margin: "10px 14px 0", fontSize: 12, color: "#64748b" }}>Træk filer hertil for at uploade til {data.path}</p>
          )}

          {listing.loading && !data ? <Empty>Henter …</Empty> : data && (
            <div style={{ overflowX: "auto", padding: "6px 4px 10px" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 520, fontSize: 14 }}>
                <thead><tr><th style={head}>Navn</th><th style={head}>Størrelse</th><th style={head}>Ændret</th><th style={head}>{data.kind === "users" || data.kind === "root" ? "Filer" : "Uploadet af"}</th></tr></thead>
                <tbody>
                  {data.parent !== null && (
                    <tr className="tg-row" style={{ cursor: "pointer" }} onClick={() => go(data.parent!)}>
                      <td style={cell} colSpan={4}><span style={{ color: "#64748b" }}>.. (op)</span></td>
                    </tr>
                  )}
                  {data.folders.map((f) => (
                    <tr key={f.path} className="tg-row" style={{ cursor: "pointer" }} onClick={() => go(f.path)}>
                      <td style={cell}>
                        <button type="button" onClick={(e) => { e.stopPropagation(); go(f.path); }}
                          style={{ display: "inline-flex", alignItems: "center", gap: 8, border: 0, background: "transparent", padding: 0, font: "inherit", fontWeight: 600, cursor: "pointer", color: "#020817" }}>
                          <Folder size={16} strokeWidth={2} color="#2563eb" aria-hidden="true" />{f.label}
                          {f.label !== f.name && <span style={{ fontFamily: MONO, fontSize: 12, color: "#94a3b8", fontWeight: 400 }}>{f.name}</span>}
                        </button>
                      </td>
                      <td style={{ ...cell, color: "#475569" }}>{fmtBytes(f.bytes)}</td>
                      <td style={{ ...cell, color: "#475569" }}>—</td>
                      <td style={{ ...cell, color: "#475569" }}>{fmtNumber(f.files)} filer</td>
                    </tr>
                  ))}
                  {data.files.map((f) => (
                    <tr key={f.id} data-deeplink={`file-row-${f.id}`} className="tg-row" onClick={() => setSelected(f.id)}
                      style={{ cursor: "pointer", background: selected === f.id ? "#eff6ff" : undefined }}>
                      <td style={cell}>
                        <button type="button" onClick={(e) => { e.stopPropagation(); setSelected(f.id); }}
                          style={{ display: "inline-flex", alignItems: "center", gap: 8, border: 0, background: "transparent", padding: 0, font: "inherit", fontWeight: 500, cursor: "pointer", color: "#020817", textAlign: "left", wordBreak: "break-all" }}>
                          <TypeIcon f={f} />{f.filename}
                        </button>
                      </td>
                      <td style={{ ...cell, color: "#475569", whiteSpace: "nowrap" }}>{fmtBytes(f.size_bytes)}</td>
                      <td style={{ ...cell, color: "#475569", whiteSpace: "nowrap" }}>{fmtDate(f.updated_at ?? f.created_at)}</td>
                      <td style={{ ...cell, color: "#475569" }}>{f.uploaded_by_name ?? "—"}</td>
                    </tr>
                  ))}
                  {!data.folders.length && !data.files.length && <tr><td colSpan={4}><Empty>Mappen er tom.</Empty></td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {selected && <Preview id={selected} onClose={() => setSelected(null)} onChanged={async (msg) => { say(msg); setSelected(null); await listing.reload(); }} />}
      </div>

      {newFolder !== null && data && (
        <Modal onClose={() => setNewFolder(null)}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <strong style={{ fontSize: 16 }}>Ny mappe i {data.path}</strong>
            <CloseBtn onClick={() => setNewFolder(null)} />
          </div>
          <form style={{ display: "flex", flexDirection: "column", gap: 12 }} onSubmit={(e) => {
            e.preventDefault();
            act("Opretter …", async () => {
              const to = data.path + newFolder.trim().replace(/^\/+|\/+$/g, "") + "/";
              await api.post(`${BASE}/folders`, { path: to });
              setNewFolder(null);
              go(to);
            });
          }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
              Navn
              <input autoFocus required maxLength={200} value={newFolder} onChange={(e) => setNewFolder(e.target.value)} placeholder="fx projekt-nord"
                style={{ height: 38, padding: "0 10px", border: "1px solid #e2e8f0", borderRadius: 8, font: "inherit" }} />
            </label>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Btn onClick={() => setNewFolder(null)}>Annuller</Btn>
              <Btn kind="primary" type="submit" icon={FolderPlus}>Opret</Btn>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

function Preview({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: (message: string) => Promise<void> }) {
  const item = useLoad(() => api.get<Item>(`${BASE}/item/${id}`), [id]);
  const [error, setError] = useState<string | null>(null);
  const [moving, setMoving] = useState<{ folder: string; name: string } | null>(null);
  const f = item.data;

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <aside data-deeplink="file-preview" aria-label="Forhåndsvisning"
      style={{ ...card, flex: "1 1 300px", maxWidth: 420, minWidth: 0, padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span style={{ fontSize: 12, color: "#64748b" }}>Forhåndsvisning</span>
        <CloseBtn onClick={onClose} />
      </div>
      {item.error && <ErrorBox>{item.error}</ErrorBox>}
      {error && <ErrorBox>{error}</ErrorBox>}
      {!f ? <Empty>Henter …</Empty> : <>
        <strong style={{ fontSize: 16, wordBreak: "break-all" }}>{f.filename}</strong>
        {f.preview === "image" && (
          <img src={`${BASE}/item/${f.id}/raw`} alt={f.filename} style={{ maxWidth: "100%", maxHeight: 320, objectFit: "contain", borderRadius: 8, background: "#f8fafc", border: "1px solid #e2e8f0" }} />
        )}
        {f.preview === "pdf" && (
          <iframe title={f.filename} src={`${BASE}/item/${f.id}/raw`} style={{ width: "100%", height: 380, border: "1px solid #e2e8f0", borderRadius: 8 }} />
        )}
        {f.preview === "text" && f.text !== undefined && (
          <pre style={{ margin: 0, maxHeight: 360, overflow: "auto", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, padding: 12, fontFamily: MONO, fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {f.text}{f.truncated && "\n\n[… afkortet – hent filen for at se resten]"}
          </pre>
        )}
        {!f.preview && <p style={{ margin: 0, fontSize: 13, color: "#64748b" }}>Filtypen kan ikke vises her. Hent den for at åbne den.</p>}
        <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "auto minmax(0, 1fr)", gap: "6px 12px", fontSize: 13 }}>
          <dt style={{ color: "#64748b" }}>Sti</dt><dd style={{ margin: 0, fontFamily: MONO, fontSize: 12, wordBreak: "break-all" }}>{f.path ?? <Pill tone="gray">{f.kind}</Pill>}</dd>
          <dt style={{ color: "#64748b" }}>Type</dt><dd style={{ margin: 0, wordBreak: "break-all" }}>{f.content_type}</dd>
          <dt style={{ color: "#64748b" }}>Størrelse</dt><dd style={{ margin: 0 }}>{fmtBytes(f.size_bytes)}</dd>
          <dt style={{ color: "#64748b" }}>Uploadet</dt><dd style={{ margin: 0 }}>{fmtDate(f.created_at)}{f.uploaded_by_name ? ` · ${f.uploaded_by_name}` : ""}</dd>
          {f.updated_at && <><dt style={{ color: "#64748b" }}>Ændret</dt><dd style={{ margin: 0 }}>{fmtDate(f.updated_at)}</dd></>}
        </dl>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <Btn kind="primary" icon={Download} onClick={() => act(async () => download((await api.get<{ url: string }>(`${BASE}/item/${f.id}/link`)).url))}>Hent</Btn>
          {f.path && <Btn icon={Pencil} onClick={() => setMoving({ folder: f.path!.slice(0, f.path!.lastIndexOf("/") + 1), name: f.filename })}>Omdøb / flyt</Btn>}
          <Btn icon={Trash2} style={{ color: "#b91c1c" }} onClick={() => confirm(`Slet ${f.filename}? Det kan ikke fortrydes.`) && act(async () => {
            await api.del(`/api/admin/files/${f.id}`);
            await onChanged(`${f.filename} er slettet`);
          })}>Slet</Btn>
        </div>
      </>}

      {moving && f && (
        <Modal onClose={() => setMoving(null)}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <strong style={{ fontSize: 16 }}>Omdøb eller flyt</strong>
            <CloseBtn onClick={() => setMoving(null)} />
          </div>
          <form style={{ display: "flex", flexDirection: "column", gap: 12 }} onSubmit={(e) => {
            e.preventDefault();
            act(async () => {
              await api.patch(`${BASE}/item/${f.id}`, { folder: moving.folder, filename: moving.name });
              setMoving(null);
              await onChanged(`${f.filename} er flyttet`);
            });
          }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
              Mappe
              <input required value={moving.folder} onChange={(e) => setMoving({ ...moving, folder: e.target.value })} placeholder="/shared/projekt/"
                style={{ height: 38, padding: "0 10px", border: "1px solid #e2e8f0", borderRadius: 8, fontFamily: MONO, fontSize: 13 }} />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
              Filnavn
              <input required maxLength={200} value={moving.name} onChange={(e) => setMoving({ ...moving, name: e.target.value })}
                style={{ height: 38, padding: "0 10px", border: "1px solid #e2e8f0", borderRadius: 8, font: "inherit" }} />
            </label>
            <p style={{ margin: 0, fontSize: 12, color: "#64748b" }}>Flyttes filen til et andet hjem eller til /shared, følger ejerskabet med.</p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Btn onClick={() => setMoving(null)}>Annuller</Btn>
              <Btn kind="primary" type="submit">Gem</Btn>
            </div>
          </form>
        </Modal>
      )}
    </aside>
  );
}
