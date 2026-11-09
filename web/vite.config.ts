import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Absolute path of src/ with forward slashes, as Vite reports module ids (also on Windows: C:/…).
const SRC = decodeURIComponent(new URL("./src/", import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1");
const ADMIN = `${SRC}admin-app/`;
// The only code the admin app and the app on / share: API client, login, the extension wire protocol and the
// deep-link plumbing (MCP links focus an element in either app).
const SHARED = [`${SRC}api.ts`, `${SRC}auth.tsx`, `${SRC}bridge/`, `${SRC}deeplink.tsx`, `${SRC}routes.json`];

const isShared = (file: string) => SHARED.some((s) => (s.endsWith("/") ? file.startsWith(s) : file === s));
const side = (file: string) => (isShared(file) ? "shared" : file.startsWith(ADMIN) ? "admin" : "app");

// Keeps /admin a separate app: admin-app/ and the rest of src/ may not import each other, and the shared
// modules may only import each other. Fails both `npm run dev` and `npm run build`.
function appBoundary(): Plugin {
  return {
    name: "gaer-app-boundary",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!importer?.startsWith(SRC)) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      const target = resolved?.id.split("?")[0];
      if (!target?.startsWith(SRC)) return resolved;
      const from = side(importer.split("?")[0]);
      const to = side(target);
      if (from !== to && to !== "shared") {
        const rel = (f: string) => f.slice(SRC.length);
        this.error(
          `${rel(importer)} imports ${rel(target)}: the ${from === "admin" ? "admin app (/admin)" : from === "shared" ? "shared code" : "app on /"} ` +
            `may not import from the ${to === "admin" ? "admin app" : "app on /"}. Shared: api.ts, auth.tsx, bridge/, deeplink.tsx, routes.json.`,
        );
      }
      return resolved;
    },
  };
}

// Two apps in one build: the app on / (index.html) and the standalone admin app on /admin (admin.html).
// In production the Python server picks the HTML file by path; in development this plugin does.
function adminEntry(): Plugin {
  return {
    name: "gaer-admin-entry",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const r = req as unknown as { url?: string };
        const path = (r.url ?? "").split("?")[0];
        if ((path === "/admin" || path.startsWith("/admin/")) && !path.includes(".")) r.url = "/admin.html";
        next();
      });
    },
  };
}

// In development Vite serves the frontend on :5173 and proxies the API to the Python server on :8000.
// In production the Python server serves the built files from web/dist itself.
export default defineConfig({
  plugins: [react(), adminEntry(), appBoundary()],
  build: {
    rollupOptions: {
      input: { main: "index.html", admin: "admin.html" },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8000",
      "/health": "http://localhost:8000",
    },
  },
});
