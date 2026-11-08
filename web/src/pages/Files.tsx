import { useRef, useState } from "react";
import { api, errorText } from "../api";
import { Alert, download, fmtBytes, fmtDate, Loading, PageHeader, useLoad } from "../ui";

type FileRow = { id: string; filename: string; content_type: string; size_bytes: number; created_at: string };

export default function Files() {
  const files = useLoad(() => api.get<FileRow[]>("/api/files"));
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of Array.from(list)) {
        const form = new FormData();
        form.append("file", file);
        await api.post("/api/files", form);
      }
      await files.reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  const open = async (id: string) => {
    try {
      const { url } = await api.get<{ url: string }>(`/api/files/${id}/link`);
      download(url);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const remove = async (f: FileRow) => {
    if (!confirm(`Slet ${f.filename}?`)) return;
    try {
      await api.del(`/api/files/${f.id}`);
      await files.reload();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <div className="page">
      <div className="spread">
        <PageHeader eyebrow="Object Storage" title="Mine filer">
          Filer gemmes i Object Storage. Download sker via et link, der kun virker i få minutter.
        </PageHeader>
        <div>
          <input ref={input} type="file" multiple hidden onChange={(e) => upload(e.target.files)} />
          <button className="btn btn-primary" disabled={busy} onClick={() => input.current?.click()}>
            {busy ? "Uploader …" : "Upload filer"}
          </button>
        </div>
      </div>
      <Alert>{error}</Alert>
      {files.loading && !files.data ? <Loading /> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Fil</th><th>Størrelse</th><th>Uploadet</th><th /></tr></thead>
            <tbody>
              {files.data?.length === 0 && <tr><td colSpan={4} className="muted">Ingen filer endnu.</td></tr>}
              {files.data?.map((f) => (
                <tr key={f.id} data-deeplink={`file-row-${f.id}`}>
                  <td className="wrap"><strong>{f.filename}</strong><div className="muted tiny">{f.content_type}</div></td>
                  <td className="num">{fmtBytes(f.size_bytes)}</td>
                  <td>{fmtDate(f.created_at)}</td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <button className="btn btn-outline btn-sm" onClick={() => open(f.id)}>Hent</button>{" "}
                    <button className="btn btn-danger btn-sm" onClick={() => remove(f)}>Slet</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
