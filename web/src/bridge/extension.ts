// Client side of the browser extension bridge (see extension/sidepanel.js).
// The app runs in an iframe inside the side panel and asks the panel for page context.

const NS = "gaer-bridge";
const TIMEOUT_MS = 10_000;

export type PageInfo = { url: string; title: string; readable: boolean };
export type PageSnapshot = { url: string; title: string; description: string; headings: string[]; selection: string; text: string };

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: number };
const pending = new Map<string, Pending>();
const tabListeners = new Set<(info: PageInfo) => void>();

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (event.source !== window.parent || !msg || msg.ns !== NS || msg.direction !== "host-to-iframe") return;
  if (msg.type === "TAB_CHANGED") {
    tabListeners.forEach((fn) => fn(msg.payload));
    return;
  }
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  clearTimeout(p.timer);
  if (msg.ok) p.resolve(msg.data);
  else p.reject(new Error(msg.error || "Fejl i udvidelsen"));
});

export function inIframe(): boolean {
  return window.self !== window.top;
}

export function request<T>(type: string, payload?: unknown, timeout = TIMEOUT_MS): Promise<T> {
  if (!inIframe()) return Promise.reject(new Error("Ikke åbnet i udvidelsen"));
  const id = crypto.randomUUID();
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pending.delete(id);
      reject(new Error("Udvidelsen svarede ikke"));
    }, timeout);
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    // The panel's origin is chrome-extension://<id>; the panel checks our origin on its side.
    window.parent.postMessage({ ns: NS, id, direction: "iframe-to-host", type, payload }, "*");
  });
}

let detected: Promise<boolean> | null = null;

/** True when the app is running inside the Gær browser extension. */
export function isExtension(): Promise<boolean> {
  detected ??= request<{ version: string }>("GET_VERSION", undefined, 1500).then(() => true, () => false);
  return detected;
}

export const extension = {
  version: () => request<{ version: string; endpoint: string }>("GET_VERSION"),
  pageInfo: () => request<PageInfo>("GET_PAGE_INFO"),
  snapshot: (maxChars = 5000) => request<PageSnapshot>("GET_PAGE_SNAPSHOT", { maxChars }),
  selection: () => request<string>("GET_SELECTION"),
  openUrl: (url: string) => request<boolean>("OPEN_URL", { url }),
  openOptions: () => request<void>("OPEN_OPTIONS"),
  onTabChanged(fn: (info: PageInfo) => void) {
    tabListeners.add(fn);
    return () => void tabListeners.delete(fn);
  },
};

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
