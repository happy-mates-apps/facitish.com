// Self-hosted analytics and heatmaps. Events go to our own server (/api/collect) and are
// stored in the container's Postgres. Nothing is sent to third parties.
//
// Without consent: anonymous page views only (no id, nothing stored in the browser).
// With consent:    a random visitor id in localStorage, a session id per tab, page flows,
//                  clicks (relative position on the page) and max scroll depth.

const CONSENT_KEY = "gaer.consent";
const VISITOR_KEY = "gaer.visitor";
const SESSION_KEY = "gaer.session";

type Consent = { statistics: boolean; version: number };

function read<T>(storage: Storage, key: string): T | null {
  try {
    const raw = storage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(storage: Storage, key: string, value: unknown) {
  try {
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage blocked */
  }
}

function randomId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return prefix + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function getConsent(): Consent | null {
  return read<Consent>(localStorage, CONSENT_KEY);
}

export async function setConsent(statistics: boolean, version: number): Promise<void> {
  let visitor = read<string>(localStorage, VISITOR_KEY);
  if (statistics && !visitor) {
    visitor = randomId("v_");
    write(localStorage, VISITOR_KEY, visitor);
  }
  write(localStorage, CONSENT_KEY, { statistics, version });
  await fetch("/api/consent", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Gaer": "1" },
    body: JSON.stringify({ statistics, version, visitor_id: visitor }),
  }).catch(() => undefined);
  if (!statistics) {
    write(localStorage, VISITOR_KEY, null);
    write(sessionStorage, SESSION_KEY, null);
  }
}

function consented(): boolean {
  return getConsent()?.statistics === true;
}

function ids(): { visitor_id?: string; session_id?: string } {
  if (!consented()) return {};
  const visitor_id = read<string>(localStorage, VISITOR_KEY) ?? undefined;
  let session_id = read<string>(sessionStorage, SESSION_KEY);
  if (!session_id) {
    session_id = randomId("s_");
    write(sessionStorage, SESSION_KEY, session_id);
  }
  return { visitor_id, session_id };
}

function send(events: Record<string, unknown>[]) {
  const body = JSON.stringify(events);
  const blob = new Blob([body], { type: "text/plain" });
  if (!navigator.sendBeacon?.("/api/collect", blob)) {
    fetch("/api/collect", { method: "POST", body, keepalive: true }).catch(() => undefined);
  }
}

// The heatmap view in /admin renders pages in an iframe; those views must not be tracked.
const inPreview = window.self !== window.top;

let currentPath: string | null = null;
let maxDepth = 0;

function tracked(path: string) {
  return !inPreview && !path.startsWith("/admin");
}

function flushScroll() {
  if (currentPath && consented() && tracked(currentPath) && maxDepth > 0) {
    send([{ kind: "scroll", path: currentPath, depth: maxDepth, ...ids() }]);
  }
  maxDepth = 0;
}

export function trackPageview(path: string) {
  if (path === currentPath) return;
  flushScroll();
  const prev = currentPath;
  currentPath = path;
  if (!tracked(path)) return;
  send([
    {
      kind: "pageview",
      path,
      prev_path: prev,
      referrer: prev ? null : document.referrer,
      viewport_w: window.innerWidth,
      ...ids(),
    },
  ]);
  requestAnimationFrame(measureScroll);
}

function measureScroll() {
  const doc = document.documentElement;
  const depth = Math.min(1, (window.scrollY + window.innerHeight) / Math.max(doc.scrollHeight, 1));
  if (depth > maxDepth) maxDepth = depth;
}

export function installTracker() {
  window.addEventListener("scroll", measureScroll, { passive: true });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushScroll();
  });
  document.addEventListener(
    "click",
    (e) => {
      if (!consented() || !currentPath || !tracked(currentPath)) return;
      const doc = document.documentElement;
      send([
        {
          kind: "click",
          path: currentPath,
          x: e.pageX / Math.max(doc.scrollWidth, 1),
          y: e.pageY / Math.max(doc.scrollHeight, 1),
          viewport_w: window.innerWidth,
          ...ids(),
        },
      ]);
    },
    { capture: true },
  );
}
