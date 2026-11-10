// The user's files on /filer and /m/filer: their own home (~/ = /users/<id>/) and the common /shared/ folder.
// Rules live on the server (server/app/filetree.py): anyone may add and overwrite in /shared, but only the uploader
// moves or deletes a shared file, and a shared folder must be empty before a user can delete it.
import { useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { api, errorText } from "../api";
import { useAuth } from "../auth";
import { Alert, download, fmtBytes, fmtDate, Loading } from "../ui";
import { isZip, pct, uploadFile, waitForUnzip, zipStem } from "../upload";

type Entry = { name: string; path: string; label: string; files: number; bytes: number };
export type TreeFile = {
  id: string; filename: string; path: string; space: "user" | "shared"; content_type: string; size_bytes: number;
  created_at: string; updated_at: string | null; preview: "image" | "pdf" | "text" | null;
  uploaded_by: number | null; uploaded_by_name?: string | null;
};
type Listing = { path: string; parent: string | null; kind: string; can_write: boolean; folders: Entry[]; files: TreeFile[] };
type Item = TreeFile & { text?: string; truncated?: boolean };

/** /users/4/noter/x.md → ~/noter/x.md for the owner. */
function shown(path: string, me: number): string {
  const home = `/users/${me}/`;
  return path.startsWith(home) ? "~/" + path.slice(home.length) : path;
}

function crumbs(path: string, me: number): { label: string; path: string }[] {
  const home = `/users/${me}/`;
  const [rootLabel, root] = path.startsWith(home) ? ["Mine filer", home] : ["Fælles", "/shared/"];
  const out = [{ label: rootLabel, path: root }];
  const parts = path.slice(root.length).split("/").filter(Boolean);
  parts.forEach((p, i) => out.push({ label: p, path: root + parts.slice(0, i + 1).join("/") + "/" }));
  return out;
}

export function FileBrowser({ compact = false, camera = false }: { compact?: boolean; camera?: boolean }) {
  const { user } = useAuth();
  const me = user?.id ?? 0;
  const [params, setParams] = useSearchParams();
  const folder = params.get("mappe") || "~/";
  const [listing, setListing] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [zipAsk, setZipAsk] = useState<File[] | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const cam = useRef<HTMLInputElement>(null);

  const load = async () => {
    setLoading(true);
    try {
      setListing(await api.get<Listing>(`/api/files/tree?path=${encodeURIComponent(folder)}`));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); setSelected(null); }, [folder]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = (path: string) => setParams(path === `/users/${me}/` || path === "~/" ? {} : { mappe: path });
  const inShared = listing?.path.startsWith("/shared/") ?? folder.startsWith("/shared");
  const atRoot = listing && (listing.path === "/shared/" || listing.path === `/users/${me}/`);

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

  const clearPickers = () => {
    if (picker.current) picker.current.value = "";
    if (cam.current) cam.current.value = "";
  };

  // Zip files: ask first whether to keep them as they are or unpack them (ZipDialog).
  const upload = (list: FileList | null) => {
    const files = Array.from(list ?? []);
    if (!listing || !files.length) return;
    if (files.some(isZip)) setZipAsk(files);
    else send(files, null);
  };

  const send = (files: File[], zip: { unzip: boolean; intoFolder: boolean } | null) => listing && act("Uploader …", async () => {
    setZipAsk(null);
    setNotice(null);
    const notes: string[] = [];
    try {
      for (const [i, f] of files.entries()) {
        const unzip = !!zip?.unzip && isZip(f);
        const label = files.length > 1 ? `${f.name} (${i + 1} af ${files.length})` : f.name;
        const r = await uploadFile(f, {
          base: "/api/files", path: listing.path, unzip, intoFolder: unzip && zip?.intoFolder,
          onProgress: (sent, total) => setProgress(`Uploader ${label} – ${pct(sent, total)}`),
        });
        if (unzip && "status" in r && r.status === "unpacking") {
          setProgress(`Pakker ${f.name} ud …`);
          const done = await waitForUnzip("/api/files", r.id, (n, total) => setProgress(`Pakker ${f.name} ud – ${n}${total ? ` af ${total}` : ""} filer`));
          const skipped = done.result?.skipped?.length ?? 0;
          notes.push(`${f.name} er pakket ud: ${done.result?.files ?? 0} filer${skipped ? `, ${skipped} sprunget over (${done.result!.skipped!.slice(0, 3).map((x) => `${x.name}: ${x.reason}`).join("; ")}${skipped > 3 ? " …" : ""})` : ""}.`);
        }
      }
    } finally {
      setProgress(null);
      clearPickers();
      await load();
    }
    if (notes.length) setNotice(notes.join(" "));
  });

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    upload(e.dataTransfer.files);
  };

  const makeFolder = (e: FormEvent) => {
    e.preventDefault();
    if (!listing || !newFolder?.trim()) return;
    act("Opretter …", async () => {
      const to = listing.path + newFolder.trim().replace(/^\/+|\/+$/g, "") + "/";
      await api.post("/api/files/folders", { path: to });
      setNewFolder(null);
      go(to);
    });
  };

  const deleteFolder = () => listing && confirm(`Slet mappen ${shown(listing.path, me)}${inShared ? "" : " med alt indhold"}?`) &&
    act("Sletter …", async () => {
      await api.del(`/api/files/folders?path=${encodeURIComponent(listing.path)}`);
      go(listing.parent ?? "~/");
    });

  const tab = (label: string, path: string, on: boolean) => (
    <button type="button" className={`btn btn-sm ${on ? "btn-dark" : "btn-outline"}`} aria-pressed={on} onClick={() => go(path)}>{label}</button>
  );

  return (
    <div className="stack" style={{ "--gap": compact ? "12px" : "16px" } as React.CSSProperties}>
      <div className="spread">
        <div className="row" style={{ "--gap": "6px" } as React.CSSProperties} role="group" aria-label="Område">
          {tab("Mine filer", "~/", !inShared)}
          {tab("Fælles", "/shared/", inShared)}
        </div>
        <div className="row" style={{ "--gap": "8px" } as React.CSSProperties}>
          <input ref={picker} type="file" multiple hidden onChange={(e) => upload(e.target.files)} />
          {camera && <>
            <input ref={cam} type="file" accept="image/*" capture="environment" hidden onChange={(e) => upload(e.target.files)} />
            <button className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => cam.current?.click()}>Tag billede</button>
          </>}
          <button className={`btn ${camera ? "btn-outline" : "btn-primary"} btn-sm`} disabled={!!busy || !listing} onClick={() => picker.current?.click()}>
            {busy ?? (camera ? "Vælg fil" : "Upload")}
          </button>
          <button className="btn btn-outline btn-sm" disabled={!listing} onClick={() => setNewFolder("")}>Ny mappe</button>
          {listing && !atRoot && <button className="btn btn-danger btn-sm" onClick={deleteFolder}>Slet mappe</button>}
        </div>
      </div>

      {listing && (
        <nav aria-label="Sti" className="row mono small" style={{ "--gap": "4px" } as React.CSSProperties}>
          {crumbs(listing.path, me).map((c, i, all) => (
            <span key={c.path} className="row" style={{ "--gap": "4px" } as React.CSSProperties}>
              {i > 0 && <span className="muted" aria-hidden="true">/</span>}
              {i === all.length - 1 ? <strong>{c.label}</strong> : <a href={`?mappe=${encodeURIComponent(c.path)}`} onClick={(e) => { e.preventDefault(); go(c.path); }}>{c.label}</a>}
            </span>
          ))}
        </nav>
      )}

      {inShared && !compact && <p className="muted small">Fælles filer kan ses og ændres af alle brugere og af AI-chatten. Kun den, der har lagt en fil her, kan flytte eller slette den.</p>}

      {newFolder !== null && (
        <form className="row" onSubmit={makeFolder} style={{ "--gap": "8px" } as React.CSSProperties}>
          <input autoFocus aria-label="Navn på ny mappe" placeholder="Navn på mappen" maxLength={200} value={newFolder} onChange={(e) => setNewFolder(e.target.value)} />
          <button className="btn btn-primary btn-sm" type="submit">Opret</button>
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => setNewFolder(null)}>Annuller</button>
        </form>
      )}

      <Alert>{error}</Alert>
      {progress && <p className="muted small" role="status" aria-live="polite" style={{ margin: 0 }}>{progress}</p>}
      <Alert kind="success">{notice}</Alert>
      {zipAsk && <ZipDialog files={zipAsk} onCancel={() => { setZipAsk(null); clearPickers(); }} onChoose={(choice) => send(zipAsk, choice)} />}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-start" }}>
        <div className="table-wrap" style={{ flex: "999 1 480px", minWidth: 0, outline: dragging ? "2px dashed var(--hm-primary)" : undefined, outlineOffset: -4 }}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
          {loading && !listing ? <div style={{ padding: 16 }}><Loading /></div> : listing && (
            <table>
              <thead><tr><th>Navn</th><th>Størrelse</th>{!compact && <th>Ændret</th>}{!compact && inShared && <th>Lagt her af</th>}</tr></thead>
              <tbody>
                {listing.folders.map((f) => (
                  <tr key={f.path} className="clickable" onClick={() => go(f.path)}>
                    <td className="wrap"><a href={`?mappe=${encodeURIComponent(f.path)}`} onClick={(e) => { e.preventDefault(); e.stopPropagation(); go(f.path); }}><strong>{f.label}/</strong></a>
                      <div className="muted tiny">{f.files} filer</div></td>
                    <td className="num">{fmtBytes(f.bytes)}</td>
                    {!compact && <td>—</td>}
                    {!compact && inShared && <td />}
                  </tr>
                ))}
                {listing.files.map((f) => (
                  <tr key={f.id} data-deeplink={`file-row-${f.id}`} className="clickable" onClick={() => setSelected(f.id)}
                    style={selected === f.id ? { background: "#eff6ff" } : undefined}>
                    <td className="wrap">
                      <button type="button" className="btn btn-ghost btn-sm" style={{ padding: 0, color: "var(--hm-foreground)", whiteSpace: "normal", textAlign: "left" }}
                        onClick={(e) => { e.stopPropagation(); setSelected(f.id); }}><strong>{f.filename}</strong></button>
                      <div className="muted tiny">{f.content_type}</div>
                    </td>
                    <td className="num">{fmtBytes(f.size_bytes)}</td>
                    {!compact && <td>{fmtDate(f.updated_at ?? f.created_at)}</td>}
                    {!compact && inShared && <td>{f.uploaded_by === me ? "Dig" : f.uploaded_by_name ?? "—"}</td>}
                  </tr>
                ))}
                {!listing.folders.length && !listing.files.length && (
                  <tr><td colSpan={4} className="muted">Mappen er tom. {compact ? "" : "Træk filer hertil for at uploade dem."}</td></tr>
                )}
              </tbody>
            </table>
          )}
        </div>
        {selected && <FilePreview id={selected} me={me} onClose={() => setSelected(null)} onChanged={async () => { setSelected(null); await load(); }} />}
      </div>
    </div>
  );
}

/** Asked before zip files are uploaded: keep them as they are, or unpack them and upload the files one by one. */
function ZipDialog({ files, onCancel, onChoose }: {
  files: File[]; onCancel: () => void; onChoose: (choice: { unzip: boolean; intoFolder: boolean }) => void;
}) {
  const zips = files.filter(isZip);
  const [intoFolder, setIntoFolder] = useState(true);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  const others = files.length - zips.length;
  const folderName = zips.length === 1 ? `${zipStem(zips[0].name)}/` : "en mappe pr. zip-fil";
  return (
    <div className="dialog-backdrop" role="presentation" onClick={onCancel}>
      <div className="card dialog" role="dialog" aria-modal="true" aria-labelledby="zip-title" onClick={(e) => e.stopPropagation()}>
        <div className="stack" style={{ "--gap": "6px" } as React.CSSProperties}>
          <div className="eyebrow">Zip-fil</div>
          <h3 id="zip-title">{zips.length === 1 ? `${zips[0].name} er en zip-fil` : `${zips.length} zip-filer`}</h3>
          <p className="muted small">
            Skal {zips.length === 1 ? "zip-filen" : "zip-filerne"} uploades, som {zips.length === 1 ? "den" : "de"} er, eller skal indholdet
            pakkes ud og uploades som enkelte filer? Mapperne i zip-filen bevares.
            {others > 0 && ` De ${others} andre filer uploades som de er.`}
          </p>
          <p className="muted tiny">{zips.map((z) => `${z.name} · ${fmtBytes(z.size)}`).join(" — ")}</p>
        </div>
        <label className="row small" style={{ "--gap": "8px" } as React.CSSProperties}>
          <input type="checkbox" checked={intoFolder} onChange={(e) => setIntoFolder(e.target.checked)} />
          Pak ud i en ny mappe ({folderName})
        </label>
        <div className="stack" style={{ "--gap": "8px" } as React.CSSProperties}>
          <button className="btn btn-primary" autoFocus onClick={() => onChoose({ unzip: true, intoFolder })}>Pak ud og upload filerne</button>
          <button className="btn btn-outline" onClick={() => onChoose({ unzip: false, intoFolder: false })}>Upload zip-filen som den er</button>
          <button className="btn btn-ghost btn-sm" onClick={onCancel}>Annullér</button>
        </div>
      </div>
    </div>
  );
}

function FilePreview({ id, me, onClose, onChanged }: { id: string; me: number; onClose: () => void; onChanged: () => Promise<void> }) {
  const [item, setItem] = useState<Item | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [moving, setMoving] = useState<{ folder: string; name: string } | null>(null);

  useEffect(() => {
    setItem(null);
    setMoving(null);
    api.get<Item>(`/api/files/${id}`).then(setItem, (e) => setError(errorText(e)));
  }, [id]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const f = item;
  const mine = f && (f.space === "user" || f.uploaded_by === me);
  const raw = `/api/files/${id}/raw`;

  return (
    <aside className="card" aria-label="Forhåndsvisning" style={{ flex: "1 1 300px", maxWidth: 440 }}>
      <div className="spread">
        <span className="eyebrow">Forhåndsvisning</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>Luk</button>
      </div>
      <Alert>{error}</Alert>
      {!f ? <Loading /> : <>
        <strong style={{ wordBreak: "break-all" }}>{f.filename}</strong>
        {f.preview === "image" && <img src={raw} alt={f.filename} style={{ maxWidth: "100%", maxHeight: 320, objectFit: "contain", borderRadius: 8, border: "1px solid var(--hm-border)" }} />}
        {f.preview === "pdf" && <iframe title={f.filename} src={raw} style={{ width: "100%", height: 360, border: "1px solid var(--hm-border)", borderRadius: 8 }} />}
        {f.preview === "text" && f.text !== undefined && (
          <pre className="json" style={{ maxHeight: 340, overflow: "auto", background: "var(--hm-muted)", borderRadius: 8, padding: 12 }}>
            {f.text}{f.truncated && "\n\n[… afkortet – hent filen for at se resten]"}
          </pre>
        )}
        {!f.preview && <p className="muted small">Filtypen kan ikke vises her. Hent den for at åbne den.</p>}
        <div className="muted tiny mono" style={{ wordBreak: "break-all" }}>{shown(f.path, me)}</div>
        <div className="muted tiny">{fmtBytes(f.size_bytes)} · {fmtDate(f.updated_at ?? f.created_at)}{f.space === "shared" && f.uploaded_by_name ? ` · ${f.uploaded_by === me ? "lagt her af dig" : `lagt her af ${f.uploaded_by_name}`}` : ""}</div>
        <div className="row" style={{ "--gap": "8px" } as React.CSSProperties}>
          <button className="btn btn-primary btn-sm" onClick={() => act(async () => download((await api.get<{ url: string }>(`/api/files/${id}/link`)).url))}>Hent</button>
          {mine && <button className="btn btn-outline btn-sm" onClick={() => setMoving({ folder: shown(f.path.slice(0, f.path.lastIndexOf("/") + 1), me), name: f.filename })}>Omdøb / flyt</button>}
          {mine && <button className="btn btn-danger btn-sm" onClick={() => confirm(`Slet ${f.filename}?`) && act(async () => { await api.del(`/api/files/${id}`); await onChanged(); })}>Slet</button>}
        </div>
        {moving && (
          <form className="stack" style={{ "--gap": "8px" } as React.CSSProperties} onSubmit={(e) => {
            e.preventDefault();
            act(async () => { await api.patch(`/api/files/${id}`, { folder: moving.folder, filename: moving.name }); await onChanged(); });
          }}>
            <label className="field">Mappe
              <input className="mono" required value={moving.folder} onChange={(e) => setMoving({ ...moving, folder: e.target.value })} placeholder="~/ eller /shared/projekt/" />
            </label>
            <div className="row" style={{ "--gap": "6px" } as React.CSSProperties}>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMoving({ ...moving, folder: "~/" })}>Mine filer</button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMoving({ ...moving, folder: "/shared/" })}>Fælles</button>
            </div>
            <label className="field">Filnavn
              <input required maxLength={200} value={moving.name} onChange={(e) => setMoving({ ...moving, name: e.target.value })} />
            </label>
            <div className="row" style={{ "--gap": "8px" } as React.CSSProperties}>
              <button className="btn btn-primary btn-sm" type="submit">Gem</button>
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => setMoving(null)}>Annuller</button>
            </div>
          </form>
        )}
      </>}
    </aside>
  );
}
