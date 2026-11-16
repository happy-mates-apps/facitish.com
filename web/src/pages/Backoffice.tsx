// /backoffice — TAS, the Terminal Assistance Simulator, inside the signed-in app (spec: specs/tas/README.md).
// The simulator is its own page (server/app/web_static/tas/, served at /w/tas/backoffice) with its own styles and
// scripts, so it is framed here rather than mounted: the app's shell stays around it, and nothing leaks either way.
// Editors (admin role Fuld adgang or Indhold, with a second factor) land in its Admin Portal; everyone else gets
// the simulator as on /w/.
import { useAuth } from "../auth";

export default function Backoffice() {
  const { user } = useAuth();
  const editor = user?.role === "admin";
  return (
    <div className="backoffice">
      <iframe
        className="backoffice-frame"
        src={`/w/tas/backoffice${editor ? "#admin" : ""}`}
        title="TAS – Terminal Assistance Simulator og Admin Portal"
        allow="clipboard-write"
      />
    </div>
  );
}
