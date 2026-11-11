// State shared by the shell and the pages: period on Statistik, active impersonation and menu badges
// (missing features, pending MCP drafts, unanswered replies to broadcasts, open reports in Moderering).
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import { useAuth } from "../auth";

export type Impersonated = { id: number; display_name: string; role: "user" | "admin" };
export type Health = { ok: boolean; version: string; ms: number } | null;

type AdminState = {
  range: number;
  setRange: (days: number) => void;
  impersonating: Impersonated | null;
  refreshImpersonation: () => Promise<void>;
  missingFeatures: number;
  setMissingFeatures: (n: number) => void;
  pendingDrafts: number;
  refreshDrafts: () => Promise<void>;
  health: Health;
  openReplies: number;
  refreshReplies: () => Promise<void>;
  openReports: number;
  refreshReports: () => Promise<void>;
};

const AdminContext = createContext<AdminState | null>(null);

export function AdminProvider({ children }: { children: ReactNode }) {
  const [range, setRange] = useState(30);
  const [impersonating, setImpersonating] = useState<Impersonated | null>(null);
  const [missingFeatures, setMissingFeatures] = useState(0);
  const [health, setHealth] = useState<Health>(null);
  const [pendingDrafts, setPendingDrafts] = useState(0);
  const [openReplies, setOpenReplies] = useState(0);
  const [openReports, setOpenReports] = useState(0);

  const refreshDrafts = useCallback(async () => {
    try {
      const r = await api.get<{ drafts: { status: string }[] }>("/api/admin/mcp/drafts");
      setPendingDrafts(r.drafts.filter((d) => d.status === "pending").length);
    } catch {
      setPendingDrafts(0);
    }
  }, []);

  const refreshReplies = useCallback(async () => {
    try {
      setOpenReplies((await api.get<{ unanswered: number }>("/api/admin/messages/replies?limit=1")).unanswered);
    } catch {
      setOpenReplies(0);
    }
  }, []);

  const refreshReports = useCallback(async () => {
    try {
      setOpenReports((await api.get<{ pending: number }>("/api/admin/messages/moderation/reports?limit=1")).pending);
    } catch {
      setOpenReports(0);
    }
  }, []);

  const refreshImpersonation = useCallback(async () => {
    try {
      const r = await api.get<{ user: Impersonated | null }>("/api/impersonation/status");
      setImpersonating(r.user);
    } catch {
      setImpersonating(null);
    }
  }, []);

  // Badges only for the sections this admin's roles open (the server would refuse the rest).
  const { user } = useAuth();
  const sections = user?.admin_sections ?? [];
  const may = (section: string) => sections.includes(section);
  useEffect(() => {
    if (may("/impersonation")) void refreshImpersonation();
    if (may("/mcp")) void refreshDrafts();
    if (may("/messages/replies")) void refreshReplies();
    if (may("/messages/moderation")) void refreshReports();
    if (may("/features")) api.get<{ missing: unknown[] }>("/api/admin/features").then((r) => setMissingFeatures(r.missing.length), () => {});
    const t0 = performance.now();
    fetch("/health", { credentials: "same-origin" })
      .then((r) => r.json())
      .then((h: { ok: boolean; version: string }) => setHealth({ ...h, ms: Math.round(performance.now() - t0) }))
      .catch(() => setHealth({ ok: false, version: "", ms: 0 }));
  }, [refreshImpersonation, refreshDrafts, refreshReplies, refreshReports, sections.join(",")]);

  return (
    <AdminContext.Provider value={{ range, setRange, impersonating, refreshImpersonation, missingFeatures, setMissingFeatures, pendingDrafts, refreshDrafts, health, openReplies, refreshReplies, openReports, refreshReports }}>
      {children}
    </AdminContext.Provider>
  );
}

export function useAdmin(): AdminState {
  const ctx = useContext(AdminContext);
  if (!ctx) throw new Error("useAdmin outside AdminProvider");
  return ctx;
}
