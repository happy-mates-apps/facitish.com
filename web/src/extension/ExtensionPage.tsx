// /extension — what the side panel shows first: the current tab, the domain consent gate,
// and capturing the page or the selection as a clip.

import { useCallback, useEffect, useState } from "react";
import { api, errorText } from "../api";
import { domainOf, extension, isExtension, type PageInfo, type PageSnapshot } from "../bridge/extension";
import { useAuth } from "../auth";
import { saveClip } from "../clips";
import { Alert, Loading } from "../ui";

export default function ExtensionPage() {
  const { config } = useAuth();
  const [inExtension, setInExtension] = useState<boolean | null>(null);
  const [tab, setTab] = useState<PageInfo | null>(null);
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [snap, setSnap] = useState<PageSnapshot | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const domain = tab ? domainOf(tab.url) : "";

  useEffect(() => {
    isExtension().then(async (yes) => {
      setInExtension(yes);
      if (yes) setTab(await extension.pageInfo());
    });
    return extension.onTabChanged((info) => {
      setTab(info);
      setSnap(null);
      setNotice(null);
    });
  }, []);

  useEffect(() => {
    setAllowed(null);
    if (!domain || !tab?.readable) return;
    api.get<{ allowed: boolean }>(`/api/bridge-consent/check?domain=${encodeURIComponent(domain)}`)
      .then((r) => setAllowed(r.allowed), (e) => setError(errorText(e)));
  }, [domain, tab?.readable]);

  const run = useCallback(async (fn: () => Promise<void>) => {
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  if (inExtension === null) return <Loading />;
  if (!inExtension) {
    return (
      <div className="card">
        <span className="eyebrow">Browserudvidelse</span>
        <p className="small">Denne side vises i sidepanelet i browserudvidelsen. Hent udvidelsen under Konto → Browserudvidelse, eller bed en administrator om den.</p>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="card">
        <span className="eyebrow">Aktuel side</span>
        <strong style={{ wordBreak: "break-word" }}>{tab?.title || "—"}</strong>
        <span className="muted tiny" style={{ wordBreak: "break-all" }}>{tab?.url}</span>
        {!tab?.readable && <Alert kind="info">Denne side kan ikke læses. Kun almindelige websider (http og https).</Alert>}
      </div>

      {tab?.readable && allowed === false && (
        <div className="card">
          <span className="eyebrow">Tilladelse</span>
          <p className="small">Må {config?.app_name ?? "appen"} læse indholdet af sider på <strong>{domain}</strong>? Det sker kun, når du selv beder om det. Du kan trække tilladelsen tilbage under Konto.</p>
          <div><button className="btn btn-primary btn-sm" onClick={() => run(async () => {
            await api.post("/api/bridge-consent", { domain });
            setAllowed(true);
          })}>Tillad {domain}</button></div>
        </div>
      )}

      {tab?.readable && allowed && (
        <div className="card">
          <span className="eyebrow">Gem fra siden</span>
          <div className="row">
            <button className="btn btn-primary btn-sm" onClick={() => run(async () => setSnap(await extension.snapshot()))}>Læs siden</button>
            <button className="btn btn-outline btn-sm" onClick={() => run(async () => {
              const sel = await extension.selection();
              if (!sel) throw new Error("Markér noget tekst på siden først");
              await saveClip({ title: `${tab.title} (markering)`, body: sel, url: tab.url, source: "extension" });
              setNotice("Markeringen er gemt som klip");
            })}>Gem markering</button>
          </div>
          {snap && (
            <div className="stack" style={{ "--gap": "8px" } as React.CSSProperties}>
              {snap.description && <p className="small muted">{snap.description}</p>}
              {snap.headings.length > 0 && (
                <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{snap.headings.slice(0, 8).map((h, i) => <li key={i}>{h}</li>)}</ul>
              )}
              {snap.selection && <p className="small"><strong>Markeret:</strong> {snap.selection.slice(0, 300)}</p>}
              <p className="tiny muted">{snap.text.length.toLocaleString("da-DK")} tegn tekst læst</p>
              <div><button className="btn btn-dark btn-sm" onClick={() => run(async () => {
                await saveClip({ title: snap.title || snap.url, body: [snap.description, snap.selection, snap.text].filter(Boolean).join("\n\n"), url: snap.url, source: "extension" });
                setNotice("Siden er gemt som klip");
              })}>Gem side som klip</button></div>
            </div>
          )}
        </div>
      )}
      <Alert kind="success">{notice}</Alert>
      <Alert>{error}</Alert>
    </div>
  );
}
