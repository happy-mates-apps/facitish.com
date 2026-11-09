// Panel conveniences in this browser, per user: open or not, tab, placement, the ring you view as and local
// ring changes. Notes and sessions are not here; they are on the server (/api/review).

export type Dock = "left" | "right";
export type Tab = "ring" | "feedback" | "session";

export type ReviewPrefs = {
  open?: boolean;
  tab?: Tab;
  dock?: Dock;
  pos?: { x: number; y: number } | null;
  collapsed?: boolean;
  level?: number | null;
  overrides?: Record<string, number>;
  markers?: boolean;
  overview?: boolean;
};

const key = (userId: number) => `gaer-review:${userId}`;

export function readPrefs(userId: number): ReviewPrefs {
  try {
    return JSON.parse(localStorage.getItem(key(userId)) ?? "{}") as ReviewPrefs;
  } catch {
    return {};
  }
}

export function writePrefs(userId: number, patch: ReviewPrefs): void {
  try {
    localStorage.setItem(key(userId), JSON.stringify({ ...readPrefs(userId), ...patch }));
  } catch {
    /* private window or storage blocked: the panel still works, it just forgets */
  }
}
