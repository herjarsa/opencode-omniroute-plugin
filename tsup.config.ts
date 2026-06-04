import { defineConfig } from "tsup";
import { execSync } from "child_process";
import { readFileSync } from "fs";

const version = JSON.parse(readFileSync("package.json", "utf8"))
  .version as string;
const gitHash = (() => {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
})();

export default defineConfig({
  define: {
    "globalThis.__PLUGIN_VERSION__": JSON.stringify(version),
    "globalThis.__PLUGIN_GIT_HASH__": JSON.stringify(gitHash),
  },
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: false,
  splitting: false,
  treeshake: false,
  target: "node22",
  outDir: "dist",
  minify: false,
  cjsInterop: true,
  // Bundle runtime deps so the .tgz / npm install is self-contained.
  // `zod` is required at runtime by the options schema and would otherwise
  // need a peer install when the plugin is loaded directly from a file path
  // in opencode.jsonc.
  noExternal: ["zod"],
});
