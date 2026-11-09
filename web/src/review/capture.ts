// Browser helpers for the review panel: a CSS selector for an element, a screenshot through the browser's
// screen sharing, and audio recording with dictation where the browser has speech recognition.
import type { Target } from "./reviewApi";

/** A short selector that finds the element again: its id, else tag:nth-of-type up to five levels. */
export function selectorFor(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node !== document.body && parts.length < 5) {
    if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) {
      parts.unshift(`#${node.id}`);
      break;
    }
    const tag = node.tagName.toLowerCase();
    const parent: Element | null = node.parentElement;
    const same = parent ? [...parent.children].filter((c) => c.tagName === node!.tagName) : [];
    parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(node) + 1})` : tag);
    node = parent;
  }
  return parts.join(" > ");
}

/** The feature an element belongs to: the nearest <FeatureGate> around it (marked in review mode). */
export function featureOf(el: Element | null): string | null {
  return el?.closest("[data-gaer-feature]")?.getAttribute("data-gaer-feature") ?? null;
}

/** Where a target is on screen now, in viewport pixels. */
export function targetRect(target: Target | null): DOMRect | null {
  if (!target) return null;
  if (target.kind === "area") return new DOMRect(target.x - window.scrollX, target.y - window.scrollY, target.w, target.h);
  try {
    return document.querySelector(target.selector)?.getBoundingClientRect() ?? null;
  } catch {
    return null;
  }
}

export const canCaptureScreen = () => !!navigator.mediaDevices?.getDisplayMedia;
export const canRecord = () => !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";

/**
 * A screenshot of this tab via screen sharing (the browser asks first). With a target and the tab itself shared,
 * the image is cropped to it. beforeGrab hides the panel; afterGrab shows it again.
 */
export async function captureScreen(target: Target | null, beforeGrab: () => Promise<void>, afterGrab: () => void): Promise<Blob> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: "browser" }, audio: false, preferCurrentTab: true, selfBrowserSurface: "include",
  } as DisplayMediaStreamOptions);
  try {
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    await beforeGrab();
    await new Promise((r) => setTimeout(r, 350)); // let the stream show the page without the panel
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    let [sx, sy, sw, sh] = [0, 0, vw, vh];
    const tabShared = (stream.getVideoTracks()[0]?.getSettings() as { displaySurface?: string }).displaySurface === "browser";
    const rect = tabShared ? targetRect(target) : null;
    if (rect) {
      const scale = vw / window.innerWidth;
      const pad = 16;
      sx = Math.max(0, (rect.left - pad) * scale);
      sy = Math.max(0, (rect.top - pad) * scale);
      sw = Math.min(vw - sx, (rect.width + pad * 2) * scale);
      sh = Math.min(vh - sy, (rect.height + pad * 2) * scale);
      if (sw < 8 || sh < 8) [sx, sy, sw, sh] = [0, 0, vw, vh];
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(sw);
    canvas.height = Math.round(sh);
    canvas.getContext("2d")!.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Billedet kunne ikke laves"))), "image/png"));
  } finally {
    afterGrab();
    stream.getTracks().forEach((t) => t.stop());
  }
}

type Recognition = {
  lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null;
  start(): void; stop(): void;
};

export type Recording = { stop: () => Promise<Blob>; dictating: boolean };

/** Records audio and, where the browser can, turns speech into text (Danish) as it is spoken. */
export async function startRecording(onText: (text: string) => void): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const recorder = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.start(1000);

  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  let recognition: Recognition | null = null;
  let stopped = false;
  if (Ctor) {
    recognition = new Ctor();
    recognition.lang = document.documentElement.lang === "en" ? "en-US" : "da-DK";
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) onText(e.results[i][0].transcript.trim());
      }
    };
    recognition.onend = () => { if (!stopped) try { recognition?.start(); } catch { /* already running */ } };
    try { recognition.start(); } catch { recognition = null; }
  }

  return {
    dictating: !!recognition,
    stop: () => new Promise<Blob>((resolve) => {
      stopped = true;
      recognition?.stop();
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        resolve(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
      };
      recorder.stop();
    }),
  };
}
