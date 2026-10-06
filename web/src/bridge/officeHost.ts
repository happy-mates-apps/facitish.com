// Protocol between the Office shell (/office-addin, which owns Office.js) and the tool
// pages it embeds in a same-origin iframe (/extension/tools/*).
//
//   tool  → shell  { ns, kind: "hello" }
//   shell → tool   { ns, kind: "office-info", info: { app, mode, fileName, ready } }
//   tool  → shell  { ns, kind: "exec", id, type, payload }
//   shell → tool   { ns, kind: "result", id, ok, data, error }

export const OFFICE_NS = "gaer-office-host";

export type OfficeApp = "word" | "excel" | "powerpoint" | "outlook" | "unknown";
export type OfficeInfo = { app: OfficeApp; mode: string | null; fileName: string | null; ready: boolean };

export type HostMessage =
  | { ns: typeof OFFICE_NS; kind: "hello" }
  | { ns: typeof OFFICE_NS; kind: "office-info"; info: OfficeInfo }
  | { ns: typeof OFFICE_NS; kind: "exec"; id: string; type: string; payload?: unknown }
  | { ns: typeof OFFICE_NS; kind: "result"; id: string; ok: boolean; data?: unknown; error?: string };

// ── Tool side ──────────────────────────────────────────────────────────────

const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: number }>();
const infoListeners = new Set<(info: OfficeInfo | null) => void>();
let currentInfo: OfficeInfo | null = null;
let listening = false;

function listen() {
  if (listening) return;
  listening = true;
  window.addEventListener("message", (event) => {
    const msg = event.data as HostMessage;
    if (event.origin !== window.location.origin || event.source !== window.parent || msg?.ns !== OFFICE_NS) return;
    if (msg.kind === "office-info") {
      currentInfo = msg.info;
      infoListeners.forEach((fn) => fn(currentInfo));
    } else if (msg.kind === "result") {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.data);
      else p.reject(new Error(msg.error || "Office-fejl"));
    }
  });
}

/** Says hello to the shell every 500 ms (up to 20 times) until it answers with office-info. */
export function connectToOffice(onInfo: (info: OfficeInfo | null) => void): () => void {
  listen();
  infoListeners.add(onInfo);
  if (currentInfo) onInfo(currentInfo);
  let tries = 0;
  const timer = window.setInterval(() => {
    if (currentInfo || window.self === window.top || ++tries > 20) {
      clearInterval(timer);
      if (!currentInfo) onInfo(null); // standalone: not inside Office
      return;
    }
    window.parent.postMessage({ ns: OFFICE_NS, kind: "hello" }, window.location.origin);
  }, 500);
  window.parent.postMessage({ ns: OFFICE_NS, kind: "hello" }, window.location.origin);
  return () => {
    clearInterval(timer);
    infoListeners.delete(onInfo);
  };
}

export function exec<T = unknown>(type: string, payload?: unknown): Promise<T> {
  listen();
  const id = crypto.randomUUID();
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pending.delete(id);
      reject(new Error("Office svarede ikke"));
    }, 15_000);
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    window.parent.postMessage({ ns: OFFICE_NS, kind: "exec", id, type, payload }, window.location.origin);
  });
}
