// /admin/go?path=/admin/users&userId=4&focus=user-block — deep links from /mcp/admin (see ../deeplink.tsx).
import { Navigate, useLocation } from "react-router-dom";
import { deepLinkTarget } from "../deeplink";

export function AdminGo() {
  const { search } = useLocation();
  const path = new URLSearchParams(search).get("path") ?? "";
  if (path && path !== "/admin" && !path.startsWith("/admin/")) {
    window.location.replace(`/go${search}`); // a link into the app on /
    return null;
  }
  return <Navigate to={deepLinkTarget(search, "/admin") ?? "/"} replace />;
}
