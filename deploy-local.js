#!/usr/bin/env node
/**
 * deploy-local.js — Build + deploy plugin to the npm-installed location.
 * 
 * Usage: node deploy-local.js
 * 
 * What it does:
 * 1. Runs `npm run build` (tsup)
 * 2. Copies dist/ to the npm-installed plugin directory
 * 3. Updates package.json version to match local version
 * 
 * After running, restart opencode for changes to take effect.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, cpSync } from "node:fs";
import { resolve } from "node:path";

const PLUGIN_DIR = "C:/Users/herna/AppData/Roaming/npm/node_modules/opencode-omniroute-plugin";
const LOCAL_VERSION = JSON.parse(readFileSync("./package.json", "utf8")).version;

console.log(`\n=== deploy-local v${LOCAL_VERSION} ===\n`);

// 1. Build
console.log("Building...");
execSync("npm run build", { stdio: "inherit" });

// 2. Verify target exists
if (!existsSync(`${PLUGIN_DIR}/dist`)) {
  console.error(`ERROR: Plugin not installed at ${PLUGIN_DIR}`);
  console.error("Run: npm install -g opencode-omniroute-plugin");
  process.exit(1);
}

// 3. Copy dist
console.log(`Copying dist/ → ${PLUGIN_DIR}/dist/`);
cpSync("./dist", `${PLUGIN_DIR}/dist`, { recursive: true });

// 4. Update version in package.json
const pkgPath = `${PLUGIN_DIR}/package.json`;
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.version = LOCAL_VERSION;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

console.log(`\n✓ Deployed v${LOCAL_VERSION} to ${PLUGIN_DIR}`);
console.log("  Restart opencode for changes to take effect.\n");
