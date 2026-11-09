// The review panel's calls to /api/review (server/app/routes/review.py). Everything is the logged-in user's own.
import { api } from "../api";

export type Impression = "good" | "meh" | "bad";
export type TaskStatus = "open" | "done" | "stuck" | "skipped";

export type ElementTarget = { kind: "element"; selector: string; tag: string; text: string };
export type AreaTarget = { kind: "area"; x: number; y: number; w: number; h: number; vw: number; vh: number };
export type Target = ElementTarget | AreaTarget;

export type Attachment = {
  id: string;
  kind: "screenshot" | "audio";
  content_type: string;
  size_bytes: number;
  created_at: string;
  url: string;
};

export type Note = {
  id: number;
  session_id: number | null;
  task_id: string | null;
  path: string;
  body: string;
  impression: Impression | null;
  feature_key: string | null;
  ring: number | null;
  target: Target | null;
  created_at: string;
  updated_at: string;
  attachments: Attachment[];
};

export type Session = {
  id: number;
  persona_key: string;
  persona: { name: string; who?: string; wants?: string; worries?: string; ring?: number | null };
  script_key: string;
  script_title: string;
  ring: number | null;
  tasks: { id: string; title: string; status: TaskStatus }[];
  pages: { path: string; at: string }[];
  notes: string;
  started_at: string;
  ended_at: string | null;
  feedback: number;
};

export type ReviewFeature = {
  key: string;
  title: string;
  description: string;
  area: string;
  ring: number;
  feedback: number;
  mine: number;
};

export const reviewApi = {
  features: () => api.get<{ level: number; features: ReviewFeature[] }>("/api/review/features"),
  notes: (path?: string) => api.get<Note[]>(`/api/review/feedback${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  createNote: (body: {
    path: string; body: string; impression: Impression | null; feature_key: string | null; ring: number | null;
    target: Target | null; session_id: number | null; task_id: string | null;
  }) => api.post<Note>("/api/review/feedback", body),
  deleteNote: (id: number) => api.del(`/api/review/feedback/${id}`),
  attach: (noteId: number, kind: Attachment["kind"], blob: Blob) => {
    const form = new FormData();
    form.append("kind", kind);
    form.append("file", blob, kind);
    return api.post<Attachment>(`/api/review/feedback/${noteId}/attachments`, form);
  },
  sessions: () => api.get<Session[]>("/api/review/sessions"),
  startSession: (body: {
    persona_key: string; persona: Session["persona"]; script_key: string; script_title: string; ring: number | null;
    tasks: { id: string; title: string }[];
  }) => api.post<Session>("/api/review/sessions", body),
  updateSession: (id: number, body: { tasks?: { id: string; status: TaskStatus }[]; notes?: string; ring?: number; end?: boolean }) =>
    api.patch<Session>(`/api/review/sessions/${id}`, body),
  visit: (id: number, path: string) => api.post<{ pages: number }>(`/api/review/sessions/${id}/visit`, { path }),
  deleteSession: (id: number) => api.del(`/api/review/sessions/${id}`),
  sessionZip: (id: number) => `/api/review/sessions/${id}/zip`,
  allZip: "/api/review/export.zip",
};
