import { build } from "esbuild";

await build({
  entryPoints: ["index.mjs"],
  bundle: true,
  minify: true,
  format: "esm",
  platform: "node",
  target: "node20",
  outfile: "dist/index.mjs",
  external: [
    "node:fs",
    "node:path",
    "node:child_process",
    "node:crypto",
    "node:sqlite",
    "better-sqlite3",
    "./lib/license.mjs",
    "./lib/update-check.mjs",
    "./lib/llm.mjs",
  ],
  banner: {
    js: [
      "// OpenClaw Memory Stack — Licensed software. All rights reserved.",
      "// SECURITY: child_process is used ONLY for sqlite3 (local DB) and qmd (local search CLI).",
      "// SECURITY: No memory content is transmitted to remote servers. Network calls are limited to:",
      "//   - openclaw-api.apptah.com: license verification only (sends key + device_id, never memory data)",
      "//   - User-configured LLM endpoint: fact extraction only (opt-in, requires API key)",
      "// SECURITY: All env vars, network endpoints, and permissions are declared in openclaw.plugin.json.",
    ].join("\n"),
  },
});

console.log("Built: plugin/dist/index.mjs");
