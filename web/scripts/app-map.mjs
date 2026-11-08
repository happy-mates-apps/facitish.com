// Writes server/app/mcp/app_map.json: every route of the app on / and of /admin with the data-deeplink anchors
// its page renders. The MCP servers only return deep links whose path and focus are in this map.
//
//   npm run app-map            regenerate
//   npm run app-map -- --check fail if the file is out of date or a catalog link has no anchor (part of the build)
//
// An anchor is a string literal in data-deeplink="…" / data-deeplink={…} or a `deeplink` prop; template literals
// like `feature-ring-${f.key}` become feature-ring-{x}.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(web, "src");
const out = resolve(web, "../server/app/mcp/app_map.json");
const catalogFile = resolve(web, "../specs/mcp/catalog.json");

const read = (f) => readFileSync(f, "utf8");

function resolveImport(from, spec) {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(from), spec);
  for (const f of [base, `${base}.tsx`, `${base}.ts`, join(base, "index.tsx"), join(base, "index.ts")]) {
    if (existsSync(f) && !f.endsWith("/")) try { read(f); return f; } catch { /* a directory */ }
  }
  return null;
}

function imports(file) {
  const map = {};
  for (const m of read(file).matchAll(/import\s+(?:(\w+)|\{([^}]+)\})(?:\s*,\s*\{([^}]+)\})?\s+from\s+"([^"]+)"/g)) {
    const target = resolveImport(file, m[4]);
    if (!target) continue;
    if (m[1]) map[m[1]] = target;
    for (const names of [m[2], m[3]]) {
      for (const n of (names ?? "").split(",")) {
        const name = n.trim().split(/\s+as\s+/).pop();
        if (name) map[name] = target;
      }
    }
  }
  return map;
}

function anchorsIn(code) {
  const found = new Set();
  const literal = (expr) => {
    for (const s of expr.matchAll(/"([a-z0-9{}_-]+)"|`([^`]+)`/g)) {
      const v = s[1] ?? s[2].replace(/\$\{[^}]+\}/g, "{x}");
      if (/^[a-z0-9{}_-]+$/.test(v)) found.add(v);
    }
  };
  for (const m of code.matchAll(/\b(?:data-deeplink|deeplink)=("([^"]+)"|\{)/g)) {
    if (m[2]) { literal(`"${m[2]}"`); continue; }
    let depth = 1, i = m.index + m[0].length;
    while (depth && i < code.length) { if (code[i] === "{") depth++; else if (code[i] === "}") depth--; i++; }
    literal(code.slice(m.index + m[0].length, i - 1));
  }
  // Action lists that render data-deeplink={a.anchor}, e.g. the user drawer.
  for (const m of code.matchAll(/\banchor:\s*("[^"]+"|`[^`]+`)/g)) literal(m[1]);
  return found;
}

/** Anchors of a page file plus the page-level files it imports from its own folder (drawers, tabs). */
function pageAnchors(file, seen = new Set()) {
  if (seen.has(file)) return new Set();
  seen.add(file);
  const anchors = anchorsIn(read(file));
  for (const target of Object.values(imports(file))) {
    if (dirname(target).startsWith(dirname(file)) && !/\/(ui|theme|api|auth|context)\.tsx?$/.test(target)) {
      for (const a of pageAnchors(target, seen)) anchors.add(a);
    }
  }
  return anchors;
}

function routes(file, prefix) {
  const code = read(file);
  const imported = imports(file);
  const result = {};
  for (const m of code.matchAll(/<Route\s+(index|path="([^"]*)")\s+element=\{([\s\S]*?)\}\s*\/?>/g)) {
    const raw = m[1] === "index" ? "" : m[2];
    if (raw === "*" || raw.includes("login")) continue;
    const path = raw.startsWith("/") ? raw : prefix + (raw ? `/${raw}` : "");
    const anchors = new Set();
    for (const c of m[3].matchAll(/<([A-Z]\w*)/g)) {
      const target = imported[c[1]];
      if (target) for (const a of pageAnchors(target)) anchors.add(a);
    }
    const key = path.replace(/\/:(\w+)/g, "/:$1") || "/";
    result[key] = { anchors: [...new Set([...(result[key]?.anchors ?? []), ...anchors])].sort() };
  }
  return result;
}

const map = {
  generated_by: "npm run app-map --prefix web",
  routes: Object.fromEntries(Object.entries({ ...routes(join(src, "App.tsx"), ""), ...routes(join(src, "admin-app/main.tsx"), "/admin") })
    .sort(([a], [b]) => a.localeCompare(b))),
};
const text = JSON.stringify(map, null, 2) + "\n";

// Every catalog link must resolve.
const problems = [];
const catalog = JSON.parse(read(catalogFile));
const routeFor = (section) => {
  const path = section.replace(/\{\w+\}/g, "1");
  return Object.entries(map.routes).find(([p]) => new RegExp(`^${p.replace(/:\w+/g, "[^/]+")}$`).test(path))?.[1];
};
// A {placeholder} on either side stands for one or more anchor characters: the catalog's analytics-{by} matches the
// literal analytics-pages, and the page's feature-ring-{x} matches a concrete feature-ring-ai.
const pattern = (s) => new RegExp(`^${s.split(/\{\w+\}/).map((p) => p.replace(/[-]/g, "\\-")).join("[a-z0-9_{}-]+")}$`);
const anchorMatches = (anchor, focus) => pattern(focus).test(anchor) || pattern(anchor).test(focus);
for (const t of catalog.tools) {
  if (!t.link) continue;
  const route = routeFor(t.link.section);
  if (!route) problems.push(`${t.server}:${t.name} → ${t.link.section} is not a route`);
  else if (t.link.focus && !route.anchors.some((a) => anchorMatches(a, t.link.focus))) {
    problems.push(`${t.server}:${t.name} → ${t.link.section} has no data-deeplink="${t.link.focus}"`);
  }
}

if (process.argv.includes("--check")) {
  if (!existsSync(out) || read(out) !== text) problems.push("server/app/mcp/app_map.json is out of date — run npm run app-map --prefix web");
} else {
  writeFileSync(out, text);
  console.log(`app_map.json: ${Object.keys(map.routes).length} routes`);
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
