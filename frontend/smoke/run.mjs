/**
 * Render smoke test: `npm run smoke`. Run it before every deploy.
 *
 * `vite build` only proves the code compiles; it never runs a page. On 2026-09-22 a clean build
 * shipped a Jobs tab that crashed on load for everyone — an imported helper was shadowed by a local
 * variable, which is legal JavaScript and only fails once real data renders (fixed in #12). This
 * test renders every tab with data and exits non-zero if any of them throws.
 *
 * It needs no Redivis login: the query hook is swapped for canned results (`mock-query.js`) and
 * the `redivis` package for an inert stub. It checks that pages *render*, not that their numbers
 * are right.
 *
 * How: bundle `render.jsx` for Node with Vite's SSR build — the same React/JSX pipeline the app
 * uses — then import and run it. The bundle goes under node_modules/.cache, which git ignores.
 */
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const outDir = path.join(root, "node_modules", ".cache", "smoke");

const stubs = {
  name: "smoke-stubs",
  enforce: "pre",
  async resolveId(source, importer, options) {
    if (source === "redivis") return "\0redivis-stub";
    const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
    if (resolved && resolved.id.endsWith("/hooks/useRedivisQuery.js")) {
      return path.join(here, "mock-query.js");
    }
    return resolved;
  },
  load(id) {
    if (id === "\0redivis-stub") {
      return "export const organization = () => ({}); export const authorize = async () => {}; export const deauthorize = async () => {}; export const isAuthorized = async () => true;";
    }
  },
};

await build({
  root,
  configFile: false,
  logLevel: "warn",
  plugins: [react(), stubs],
  ssr: { noExternal: true },
  build: {
    ssr: path.join(here, "render.jsx"),
    outDir,
    emptyOutDir: true,
    rollupOptions: { output: { entryFileNames: "render.mjs" } },
  },
});

const { run } = await import(pathToFileURL(path.join(outDir, "render.mjs")).href);
process.exitCode = run() ? 1 : 0;
