// What the review panel draws over the page: pointing at an element, marking an area, the target of the
// note being written, and ring markers around every <FeatureGate> on the page.
import { useEffect, useRef, useState } from "react";
import { featureOf, selectorFor, targetRect } from "./capture";
import { RINGS } from "./rings";
import type { AreaTarget, ElementTarget, Target } from "./reviewApi";

const inPanel = (el: Element | null) => !!el?.closest(".review-root");

/** Hover highlights, click picks. Esc cancels. The page's own click handlers do not run. */
export function ElementPicker({ onPick, onCancel }: { onPick: (t: ElementTarget, feature: string | null) => void; onCancel: () => void }) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    let current: Element | null = null;
    const move = (e: MouseEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || inPanel(el) || el === current) return;
      current = el;
      setRect(el.getBoundingClientRect());
    };
    const click = (e: MouseEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || inPanel(el)) return;
      e.preventDefault();
      e.stopPropagation();
      const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
      onPick({ kind: "element", selector: selectorFor(el), tag: el.tagName.toLowerCase(), text }, featureOf(el));
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    document.addEventListener("mousemove", move, true);
    document.addEventListener("click", click, true);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("mousemove", move, true);
      document.removeEventListener("click", click, true);
      document.removeEventListener("keydown", key, true);
    };
  }, [onPick, onCancel]);
  return (
    <>
      <div className="review-hint" role="status">Klik på det element, noten handler om · Esc fortryder</div>
      {rect && <div className="review-box picking" style={box(rect)} aria-hidden="true" />}
    </>
  );
}

/** Drag a rectangle over the page. Esc cancels. */
export function AreaSelect({ onPick, onCancel }: { onPick: (t: AreaTarget, feature: string | null) => void; onCancel: () => void }) {
  const [start, setStart] = useState<{ x: number; y: number } | null>(null);
  const [end, setEnd] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [onCancel]);
  const rect = start && end ? new DOMRect(Math.min(start.x, end.x), Math.min(start.y, end.y),
                                          Math.abs(end.x - start.x), Math.abs(end.y - start.y)) : null;
  return (
    <div
      className="review-area-layer"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        setStart({ x: e.clientX, y: e.clientY });
        setEnd({ x: e.clientX, y: e.clientY });
      }}
      onPointerMove={(e) => start && setEnd({ x: e.clientX, y: e.clientY })}
      onPointerUp={(e) => {
        if (!rect || rect.width < 8 || rect.height < 8) {
          setStart(null);
          return;
        }
        const layer = e.currentTarget;
        layer.style.pointerEvents = "none";
        const under = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        layer.style.pointerEvents = "";
        onPick({ kind: "area", x: Math.round(rect.x + window.scrollX), y: Math.round(rect.y + window.scrollY),
                 w: Math.round(rect.width), h: Math.round(rect.height), vw: window.innerWidth, vh: window.innerHeight },
               featureOf(under));
      }}
    >
      <div className="review-hint" role="status">Træk en firkant over det, noten handler om · Esc fortryder</div>
      {rect && <div className="review-box area" style={box(rect)} aria-hidden="true" />}
    </div>
  );
}

/** Keeps a box around the target of the note being written. */
export function TargetBox({ target }: { target: Target }) {
  const rect = useTick(() => targetRect(target));
  return rect ? <div className="review-box target" style={box(rect)} aria-hidden="true" /> : null;
}

type Marker = { key: string; ring: number | null; rect: DOMRect; local: boolean };

/** A dashed frame and a badge around each feature on the page. The badge changes the ring in this browser. */
export function RingMarkers({ ringOf, localKeys, onSetRing }: {
  ringOf: (key: string) => number | null;
  localKeys: Set<string>;
  onSetRing: (key: string, ring: number | null) => void;
}) {
  const markers = useTick<Marker[]>(() => {
    const seen = new Map<string, Marker>();
    document.querySelectorAll("[data-gaer-feature]").forEach((el, i) => {
      if (inPanel(el)) return;
      const range = document.createRange();
      range.selectNodeContents(el);
      const rect = range.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return;
      const key = el.getAttribute("data-gaer-feature")!;
      seen.set(`${key}:${i}`, { key, ring: ringOf(key), rect, local: localKeys.has(key) });
    });
    return [...seen.values()];
  }) ?? [];
  const [menu, setMenu] = useState<string | null>(null);
  return (
    <div className="review-markers">
      {markers.map((m, i) => {
        const ring = RINGS[m.ring ?? 0];
        return (
          <div key={`${m.key}-${i}`} className="review-marker" style={{ ...box(m.rect), borderColor: ring?.color ?? "#64748b" }}>
            <button
              type="button"
              className="review-marker-badge"
              style={{ background: ring?.color ?? "#64748b" }}
              aria-label={`Feature ${m.key}, ring ${m.ring ?? "ukendt"}. Skift ring i din browser`}
              onClick={() => setMenu(menu === `${m.key}-${i}` ? null : `${m.key}-${i}`)}
            >
              {m.ring ? `R${m.ring}` : "?"} {m.key}{m.local ? " *" : ""}
            </button>
            {menu === `${m.key}-${i}` && (
              <div className="review-marker-menu" role="menu">
                {[1, 2, 3, 4].map((r) => (
                  <button key={r} type="button" role="menuitem" onClick={() => { onSetRing(m.key, r); setMenu(null); }}>
                    <span className="review-chip" style={{ background: RINGS[r].bg, color: RINGS[r].ink }}>R{r}</span> {RINGS[r].name}
                  </button>
                ))}
                {m.local && (
                  <button type="button" role="menuitem" onClick={() => { onSetRing(m.key, null); setMenu(null); }}>
                    Nulstil til serverens ring
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function box(r: DOMRect) {
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

/** Re-measures on scroll, resize and a few times a second (the page may change under us). */
function useTick<T>(measure: () => T): T | null {
  const [value, setValue] = useState<T | null>(null);
  const latest = useRef(measure);
  latest.current = measure;
  useEffect(() => {
    let frame = 0;
    const run = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setValue(latest.current()));
    };
    run();
    const timer = window.setInterval(run, 400);
    window.addEventListener("scroll", run, true);
    window.addEventListener("resize", run);
    return () => {
      cancelAnimationFrame(frame);
      window.clearInterval(timer);
      window.removeEventListener("scroll", run, true);
      window.removeEventListener("resize", run);
    };
  }, []);
  return value;
}
