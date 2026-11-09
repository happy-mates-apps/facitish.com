// Adoption tracking: the pages a signed-in user opens in the app on /, on /m and in the extension are sent in batches to
// /api/adoption/visits, where /admin/adoption measures journeys on them. Only while an admin has turned tracking on: when
// the server says it is off, nothing more is sent for ten minutes. The heatmap preview in /admin (a same-origin frame) is
// not tracked; the extension's side panel (a cross-origin frame) is.

const FLUSH_MS = 10_000;
const OFF_MS = 10 * 60_000;

let pending: string[] = [];
let timer = 0;
let offUntil = 0;
let last: string | null = null;

function inAdminPreview(): boolean {
  try {
    return window.frameElement !== null;
  } catch {
    return false;
  }
}

function flush(keepalive = false) {
  window.clearTimeout(timer);
  timer = 0;
  if (!pending.length) return;
  const paths = pending.slice(0, 50);
  pending = [];
  fetch("/api/adoption/visits", {
    method: "POST", keepalive, credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-Gaer": "1" }, body: JSON.stringify({ paths }),
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((body: { tracking?: boolean } | null) => {
      if (body && body.tracking === false) offUntil = Date.now() + OFF_MS;
    })
    .catch(() => {});
}

export function noteVisit(path: string) {
  if (path === last || Date.now() < offUntil || inAdminPreview() || path.startsWith("/admin")) return;
  last = path;
  pending.push(path);
  if (pending.length >= 50) flush();
  else timer ||= window.setTimeout(flush, FLUSH_MS);
}

window.addEventListener("pagehide", () => flush(true));
