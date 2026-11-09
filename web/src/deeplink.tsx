// Deep links from the MCP servers: <origin>/go?path=/klip/12&focus=clip-body and /admin/go?path=/admin/users&userId=4&focus=user-block.
// /go and /admin/go navigate to `path` with the other arguments as query; useDeepLinkFocus() then waits for
// [data-deeplink="<focus>"], opens a hidden parent ([data-deeplink-parent], e.g. <details>), scrolls to it, focuses it
// and rings it for 2 s. Anchors are listed per route in server/app/mcp/app_map.json (npm run app-map).
import { useEffect } from "react";
import { Navigate, useLocation } from "react-router-dom";

const WAIT_MS = 5000;

function ring(el: HTMLElement) {
  const parent = el.closest<HTMLElement>("[data-deeplink-parent]");
  if (parent instanceof HTMLDetailsElement) parent.open = true;
  const top = el.getBoundingClientRect().top + window.scrollY - 96;
  window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  if (!el.hasAttribute("tabindex") && !/^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) el.setAttribute("tabindex", "-1");
  el.focus({ preventScroll: true });
  const before = { outline: el.style.outline, offset: el.style.outlineOffset, shadow: el.style.boxShadow };
  el.style.outline = "2px solid #2563eb";
  el.style.outlineOffset = "2px";
  el.style.boxShadow = "0 0 0 6px rgba(37,99,235,0.18)";
  window.setTimeout(() => {
    el.style.outline = before.outline;
    el.style.outlineOffset = before.offset;
    el.style.boxShadow = before.shadow;
  }, 2000);
}

/** Highlights the element named by ?focus= once it is rendered. Mount once per app. */
export function useDeepLinkFocus() {
  const { search, pathname } = useLocation();
  useEffect(() => {
    const focus = new URLSearchParams(search).get("focus");
    if (!focus) return;
    const selector = `[data-deeplink="${CSS.escape(focus)}"]`;
    const found = document.querySelector<HTMLElement>(selector);
    if (found) {
      ring(found);
      return;
    }
    const observer = new MutationObserver(() => {
      const el = document.querySelector<HTMLElement>(selector);
      if (el) {
        observer.disconnect();
        window.clearTimeout(timer);
        ring(el);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-deeplink"] });
    const timer = window.setTimeout(() => observer.disconnect(), WAIT_MS);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [search, pathname]);
}

/** Target of a deep link: `path` plus the remaining query (args and focus). `strip` removes a router basename. */
export function deepLinkTarget(search: string, strip = ""): string | null {
  const q = new URLSearchParams(search);
  const path = q.get("path");
  if (!path || !path.startsWith("/") || path.startsWith("//")) return null;
  q.delete("path");
  const rest = q.toString();
  const local = strip && (path === strip || path.startsWith(strip + "/")) ? path.slice(strip.length) || "/" : path;
  return local + (rest ? `?${rest}` : "");
}

/** /go in the app on /. Links into /admin are handed to the admin app. */
export function GoPage() {
  const { search } = useLocation();
  const target = deepLinkTarget(search);
  if (target && (target === "/admin" || target.startsWith("/admin/") || target.startsWith("/admin?"))) {
    window.location.replace(`/admin/go${search}`);
    return null;
  }
  return <Navigate to={target ?? "/"} replace />;
}
