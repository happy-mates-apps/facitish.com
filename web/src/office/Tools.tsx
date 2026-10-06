// Tool pages shown inside the Office shell's iframe: /extension/tools/word, /outlook and /document.
// They hold login and UI; Office.js calls go to the shell through exec().

import { useEffect, useState, type ReactNode } from "react";
import { Outlet } from "react-router-dom";
import { errorText } from "../api";
import { useAuth } from "../auth";
import { connectToOffice, exec, type OfficeInfo } from "../bridge/officeHost";
import { ClipsList, saveClip, useClips } from "../clips";
import { Alert, Loading } from "../ui";

const APP_NAME: Record<string, string> = { word: "Word", excel: "Excel", powerpoint: "PowerPoint", outlook: "Outlook", unknown: "Office" };

function useOffice() {
  const [info, setInfo] = useState<OfficeInfo | null | undefined>(undefined);
  useEffect(() => connectToOffice(setInfo), []);
  return info; // undefined: still connecting · null: not inside Office
}

function useAction() {
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (ok) setNotice(ok);
    } catch (e) {
      setError(errorText(e));
    }
  };
  const messages = (<><Alert kind="success">{notice}</Alert><Alert>{error}</Alert></>);
  return { run, messages };
}

export function ToolLayout() {
  const { config, user, logout } = useAuth();
  return (
    <div className="embed-shell">
      <header className="embed-header">
        {config?.logo_url ? <img src={config.logo_url} alt="" /> : <span className="brand-dot" style={{ width: 20, height: 20 }} />}
        <strong>{config?.app_name ?? "Gær"}</strong>
        <span className="muted tiny" style={{ marginLeft: "auto" }}>{user?.display_name || user?.phone}</span>
        <button className="btn btn-ghost btn-sm" onClick={async () => { await logout(); window.location.reload(); }}>Log ud</button>
      </header>
      <main className="embed-main"><Outlet /></main>
    </div>
  );
}

function OfficeGate({ children }: { children: (info: OfficeInfo) => ReactNode }) {
  const info = useOffice();
  if (info === undefined) return <Loading />;
  if (info === null) {
    return <Alert kind="info">Denne side virker inde i Office. Installér tilføjelsen fra /admin/integrations, og åbn den fra båndet i Word eller Outlook.</Alert>;
  }
  return <>{children(info)}</>;
}

export function WordTool() {
  const clips = useClips();
  const { run, messages } = useAction();
  return (
    <OfficeGate>{(info) => (
      <div className="stack">
        <div className="card">
          <span className="eyebrow">{APP_NAME[info.app]}{info.fileName ? ` · ${info.fileName}` : ""}</span>
          <div className="row">
            <button className="btn btn-outline btn-sm" onClick={() => run(async () => {
              const sel = await exec<string>("GET_SELECTION");
              if (!sel?.trim()) throw new Error("Markér noget tekst i dokumentet først");
              await saveClip({ title: sel.trim().split("\n")[0].slice(0, 80), body: sel, source: "word" });
              await clips.reload();
            }, "Markeringen er gemt som klip")}>Gem markering som klip</button>
          </div>
        </div>
        {messages}
        <ClipsList clips={clips} compact source="word" actions={(c) => (
          <>
            <button className="btn btn-primary btn-sm" onClick={() => run(() => exec("INSERT_TEXT", { text: c.body }), "Indsat ved markøren")}>Indsæt</button>
            <button className="btn btn-outline btn-sm" onClick={() => run(() => exec("WORD_INSERT_PARAGRAPH", { text: c.body }), "Tilføjet sidst i dokumentet")}>Sidst i dok.</button>
            <button className="btn btn-ghost btn-sm" onClick={() => run(() => exec("WORD_ADD_COMMENT", { text: c.body }), "Kommentar tilføjet")}>Som kommentar</button>
          </>
        )} />
      </div>
    )}</OfficeGate>
  );
}

type Mail = { subject: string; body: string; from: string | null; compose: boolean; date: string | null };

export function OutlookTool() {
  const clips = useClips();
  const { run, messages } = useAction();
  const [mail, setMail] = useState<Mail | null>(null);
  return (
    <OfficeGate>{(info) => {
      const compose = mail?.compose ?? info.mode === "compose";
      return (
        <div className="stack">
          <div className="card">
            <span className="eyebrow">Outlook · {compose ? "ny mail" : "læser mail"}</span>
            <div className="row">
              <button className="btn btn-outline btn-sm" onClick={() => run(async () => setMail(await exec<Mail>("OUTLOOK_READ_ITEM")))}>Læs mailen</button>
              {mail && <button className="btn btn-dark btn-sm" onClick={() => run(async () => {
                await saveClip({ title: mail.subject || "Mail uden emne", body: [mail.from && `Fra: ${mail.from}`, mail.body].filter(Boolean).join("\n\n"), source: "outlook" });
                await clips.reload();
              }, "Mailen er gemt som klip")}>Gem som klip</button>}
            </div>
            {mail && (
              <div className="stack" style={{ "--gap": "4px" } as React.CSSProperties}>
                <strong className="small">{mail.subject || "(intet emne)"}</strong>
                {mail.from && <span className="muted tiny">{mail.from}</span>}
                <p className="small" style={{ whiteSpace: "pre-wrap", maxHeight: 120, overflow: "auto", color: "#334155" }}>{mail.body}</p>
              </div>
            )}
          </div>
          {messages}
          <ClipsList clips={clips} compact source="outlook" actions={(c) => compose ? (
            <>
              <button className="btn btn-primary btn-sm" onClick={() => run(() => exec("INSERT_TEXT", { text: c.body }), "Indsat ved markøren")}>Indsæt</button>
              <button className="btn btn-outline btn-sm" onClick={() => run(() => exec("OUTLOOK_PREPEND_BODY", { text: c.body + "\n\n" }), "Indsat øverst")}>Øverst</button>
              <button className="btn btn-ghost btn-sm" onClick={() => run(() => exec("OUTLOOK_SET_SUBJECT", { text: c.title }), "Emnet er sat")}>Brug titel som emne</button>
            </>
          ) : (
            <>
              <button className="btn btn-primary btn-sm" onClick={() => run(() => exec("OUTLOOK_OPEN_REPLY", { text: c.body }))}>Svar med klip</button>
              <button className="btn btn-outline btn-sm" onClick={() => run(() => exec("OUTLOOK_OPEN_REPLY", { text: c.body, all: true }))}>Svar alle</button>
            </>
          )} />
        </div>
      );
    }}</OfficeGate>
  );
}

export function DocumentTool() {
  const clips = useClips();
  const { run, messages } = useAction();
  return (
    <OfficeGate>{(info) => (
      <div className="stack">
        <div className="card">
          <span className="eyebrow">{APP_NAME[info.app]}{info.fileName ? ` · ${info.fileName}` : ""}</span>
          <p className="small muted">Indsæt et klip i den markerede celle eller tekstboks.</p>
        </div>
        {messages}
        <ClipsList clips={clips} compact actions={(c) => (
          <button className="btn btn-primary btn-sm" onClick={() => run(() => exec("INSERT_TEXT", { text: c.body }), "Indsat")}>Indsæt</button>
        )} />
      </div>
    )}</OfficeGate>
  );
}
