/**
 * Bare-key static-catalog contract (upstream #9175 / #9178).
 *
 * The static catalog path (`buildStaticProviderEntry`) used to write model
 * dict keys with an embedded provider prefix (`opencode-omniroute/<raw-id>`,
 * `omniroute/<combo-slug>`). OpenCode's `getModel` looks up models by BARE id
 * (the part after the first slash in the user's request), so the prefix made
 * user combos and non-slashed raw models unreachable — calling
 * `omniroute/reasoning` reached OmniRoute's server doubled and
 * `parseModel()` resolved credentials for the nonexistent provider
 * `omniroute` → 404 "No active credentials for provider: omniroute".
 *
 * Spec (upstream fix #9178, merged 2026-08-06): every static-catalog dict key
 * MUST be the bare id — `models[raw.id]` for raw models (slashed ids like
 * `cc/claude-opus-4-7` stay as-is, they are already bare) and the bare combo
 * slug (last segment of `buildComboKey`) for user combos.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildStaticProviderEntry,
  resolveOmniRoutePluginOptions,
  type OmniRouteRawCombo,
  type OmniRouteRawModelEntry,
} from "../src/index.js";

// ────────────────────────────────────────────────────────────────────────────
// Fixtures — shapes straight from the upstream /v1/models + /api/combos
// ────────────────────────────────────────────────────────────────────────────

function model(
  id: string,
  contextLength = 200_000,
  maxOutput = 64_000
): OmniRouteRawModelEntry {
  return {
    id,
    context_length: contextLength,
    max_output_tokens: maxOutput,
    capabilities: {
      tool_calling: true,
      reasoning: true,
      vision: false,
      temperature: true,
    },
    input_modalities: ["text"],
    output_modalities: ["text"],
  };
}

function combo(name: string, memberIds: string[]): OmniRouteRawCombo {
  return {
    id: `combo-${name.toLowerCase().replace(/\s+/g, "-")}`,
    name,
    strategy: "priority",
    models: memberIds.map((m, i) => ({ id: `s${i}`, kind: "model", model: m, weight: 100 })),
  };
}

const BASE = "https://or.example/v1";

function buildBlock() {
  const resolved = resolveOmniRoutePluginOptions({ providerId: "omniroute" });
  return buildStaticProviderEntry(
    [model("claude-sonnet-4-6"), model("cc/claude-opus-4-7")],
    [combo("Claude Primary", ["claude-sonnet-4-6"])],
    resolved,
    BASE,
    "sk-test"
  );
}

// ────────────────────────────────────────────────────────────────────────────
// 1. Raw models — bare keys
// ────────────────────────────────────────────────────────────────────────────

test("bare-key: raw model without slash is keyed by its bare id (no provider prefix)", () => {
  const block = buildBlock();
  const key = "claude-sonnet-4-6";
  assert.ok(
    block.models[key],
    `raw model must be reachable under bare key '${key}' (got: ${Object.keys(block.models).join(", ")})`
  );
  assert.equal(block.models[key].name, "claude-sonnet-4-6");
});

test("bare-key: raw model with slash keeps its full id as key", () => {
  const block = buildBlock();
  const key = "cc/claude-opus-4-7";
  assert.ok(
    block.models[key],
    `slashed raw model must stay keyed under '${key}' (got: ${Object.keys(block.models).join(", ")})`
  );
});

test("bare-key: no dict key carries an omniroute/ or opencode-omniroute/ prefix", () => {
  const block = buildBlock();
  const offending = Object.keys(block.models).filter(
    (k) => k.startsWith("omniroute/") || k.startsWith("opencode-omniroute/")
  );
  assert.deepEqual(
    offending,
    [],
    `static-catalog dict keys must be bare — found prefixed keys: ${offending.join(", ")}`
  );
});

// ────────────────────────────────────────────────────────────────────────────
// 2. User combos — bare slug keys
// ────────────────────────────────────────────────────────────────────────────

test("bare-key: user combo is keyed by its bare slug (no omniroute/ prefix)", () => {
  const block = buildBlock();
  const key = "claude-primary";
  assert.ok(
    block.models[key],
    `combo must be reachable under bare slug '${key}' (got: ${Object.keys(block.models).join(", ")})`
  );
  assert.equal(block.models[key].name, "Claude Primary");
});

test("bare-key: combo limit survives the bare-key rewrite (LCD contract intact)", () => {
  const block = buildBlock();
  const entry = block.models["claude-primary"];
  assert.ok(entry);
  assert.equal(entry.limit?.context, 200_000);
  assert.equal(entry.limit?.output, 64_000);
});
