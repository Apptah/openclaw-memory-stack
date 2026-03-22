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
  ],
  banner: {
    js: "// OpenClaw Memory Stack — Licensed software. All rights reserved.",
  },
});

console.log("Built: plugin/dist/index.mjs");
