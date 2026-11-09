// Opens and closes the review panel: ⌃⌥⌘W on a Mac (Ctrl+Alt+Shift+W elsewhere) or ?review=1 / ?review=0.
// Only for logged-in users: an anonymous visitor who asks for the panel is sent to /login and back.
// The panel's code is loaded only when it opens, so ordinary visits never fetch it.
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth";
import { readPrefs, writePrefs } from "./prefs";

const ReviewPanel = lazy(() => import("./ReviewPanel"));

export function isReviewShortcut(e: KeyboardEvent): boolean {
  return e.code === "KeyW" && e.ctrlKey && e.altKey && (e.metaKey || e.shiftKey);
}

export default function ReviewLauncher() {
  const { user, scope, loading } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [wanted, setWanted] = useState(false); // asked for while logged out
  const loggedIn = !!user && scope === "full";

  const toggle = useCallback((next: boolean) => {
    setOpen(next);
    if (user) writePrefs(user.id, { open: next });
  }, [user]);

  // The remembered choice, once we know who is logged in.
  useEffect(() => {
    if (user) setOpen(!!readPrefs(user.id).open);
  }, [user]);

  // ?review=1 / ?review=0, then the parameter is removed from the address.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const value = params.get("review");
    if (value === null || loading) return;
    params.delete("review");
    const search = params.toString();
    if (value === "1" && !loggedIn) {
      setWanted(true);
      return;
    }
    toggle(value === "1");
    navigate({ pathname: location.pathname, search: search ? `?${search}` : "", hash: location.hash },
             { replace: true, state: location.state });
  }, [location, loading, loggedIn, navigate, toggle]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isReviewShortcut(e)) return;
      e.preventDefault();
      if (loggedIn) toggle(!open);
      else setWanted(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [loggedIn, open, toggle]);

  // Logged out: to /login, then back here with ?review=1 so the panel opens.
  useEffect(() => {
    if (!wanted || loading || loggedIn || location.pathname.endsWith("/login")) return;
    setWanted(false);
    const params = new URLSearchParams(location.search);
    params.set("review", "1");
    navigate("/login", { state: { from: `${location.pathname}?${params}` } });
  }, [wanted, loading, loggedIn, location, navigate]);

  if (!open || !loggedIn) return null;
  return (
    <Suspense fallback={null}>
      <ReviewPanel onClose={() => toggle(false)} />
    </Suspense>
  );
}
