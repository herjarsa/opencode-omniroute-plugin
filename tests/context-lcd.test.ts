/**
 * Fork feature: LCD (least-common-denominator) context windows extracted
 * from upstream model data.
 *
 * Spec (user): the plugin extracts `context_length` for every model from the
 * upstream runtime; a combo (including nested combo-refs) takes as its
 * context the MINIMUM `context_length` across its resolved members. That
 * minimum is the value the combo advertises.
 *
 * The upstream runtime exposes many models with `context_length` but WITHOUT
 * `max_output_tokens` (e.g. OmniRoute 3.8.49: 593 models lack it). OpenCode's
 * static-catalog schema requires BOTH `context` and `output` when `limit` is
 * present, so the fork derives `output` from a conservative fallback
 * (`FALLBACK_OUTPUT_TOKENS`) instead of dropping `limit` — which previously
 * made OpenCode report context 0 for 321/434 catalog models.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildStaticProviderEntry,
  resolveOmniRoutePluginOptions,
  FALLBACK_OUTPUT_TOKENS,
  type OmniRouteRawCombo,
  type OmniRouteRawModelEntry,
} from "../src/index.js";

// ────────────────────────────────────────────────────────────────────────────
// Fixtures — model shapes straight from the upstream /v1/models payload
// ────────────────────────────────────────────────────────────────────────────

/** Model with context but NO max_output_tokens — the common upstream shape. */
function ctxOnlyModel(id: string, contextLength: number): OmniRouteRawModelEntry {
  return {
    id,
    context_length: contextLength,
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

/** Model with BOTH context and output — the rare upstream shape. */
function fullModel(id: string, contextLength: number, maxOutput: number): OmniRouteRawModelEntry {
  return {
    ...ctxOnlyModel(id, contextLength),
    max_output_tokens: maxOutput,
  };
}

function combo(id: string, name: string, members: OmniRouteRawCombo["models"]): OmniRouteRawCombo {
  return { id, name, models: members };
}

const BASE = "https://or.example/v1";

/**
 * Find a catalog entry by display name — robust against providerId
 * prefixes (`opencode-omniroute/…`) and combo-slug normalisation
 * (`buildComboKey` lowercases and strips separators).
 */
function byName(
  block: Awaited<ReturnType<typeof buildStaticProviderEntry>>,
  name: string
) {
  return Object.values(block.models).find((m) => m.name === name);
}

// ────────────────────────────────────────────────────────────────────────────
// 1. Models — limit emitted with context + derived output fallback
// ────────────────────────────────────────────────────────────────────────────

test("LCD: model with context_length but no max_output_tokens still emits limit.context", () => {
  const resolved = resolveOmniRoutePluginOptions({ providerId: "omniroute" });
  const block = buildStaticProviderEntry(
    [ctxOnlyModel("claude-ctx-only", 200_000)],
    [],
    resolved,
    BASE,
    "sk-test"
  );
  const entry = byName(block, "claude-ctx-only");
  assert.ok(entry, "model must be in the static catalog");
  assert.equal(entry.limit?.context, 200_000, "context must come from upstream context_length");
  assert.ok(
    typeof entry.limit?.output === "number" && entry.limit.output > 0,
    "output must be derived (OC schema requires both fields when limit is present)"
  );
});

test("LCD: derived output fallback is FALLBACK_OUTPUT_TOKENS capped by context", () => {
  const resolved = resolveOmniRoutePluginOptions({ providerId: "omniroute" });
  const block = buildStaticProviderEntry(
    [ctxOnlyModel("tiny-ctx", 4_096)],
    [],
    resolved,
    BASE,
    "sk-test"
  );
  const entry = byName(block, "tiny-ctx");
  assert.equal(entry.limit?.output, 4_096, "output never exceeds the context window");
});

test("LCD: model with BOTH fields keeps its real max_output_tokens", () => {
  const resolved = resolveOmniRoutePluginOptions({ providerId: "omniroute" });
  const block = buildStaticProviderEntry(
    [fullModel("claude-full", 200_000, 64_000)],
    [],
    resolved,
    BASE,
    "sk-test"
  );
  const entry = byName(block, "claude-full");
  assert.equal(entry.limit?.context, 200_000);
  assert.equal(entry.limit?.output, 64_000, "real output must win when present");
});

test("LCD: model without context_length AND without output emits no limit (unchanged)", () => {
  const resolved = resolveOmniRoutePluginOptions({ providerId: "omniroute" });
  const block = buildStaticProviderEntry(
    [{ id: "no-ctx", capabilities: {}, input_modalities: ["text"], output_modalities: ["text"] }],
    [],
    resolved,
    BASE,
    "sk-test"
  );
  const entry = byName(block, "no-ctx");
  assert.equal(entry.limit, undefined);
});

// ────────────────────────────────────────────────────────────────────────────
// 2. Combos — context = MIN over resolved members, output derived when missing
// ────────────────────────────────────────────────────────────────────────────

test("LCD: combo context is the MIN of member context_lengths (no outputs on members)", () => {
  const resolved = resolveOmniRoutePluginOptions({ providerId: "omniroute" });
  const rawModels = [
    ctxOnlyModel("big", 200_000),
    ctxOnlyModel("small", 8_000),
  ];
  const rawCombos = [
    combo("my-combo", "MyCombo", [
      { id: "m1", kind: "model", model: "big", weight: 100 },
      { id: "m2", kind: "model", model: "small", weight: 80 },
    ]),
  ];
  const block = buildStaticProviderEntry(rawModels, rawCombos, resolved, BASE, "sk-test");
  const entry = byName(block, "MyCombo");
  assert.ok(entry, "combo must be in the static catalog");
  assert.equal(entry.limit?.context, 8_000, "min of member contexts is the combo context");
  assert.ok(
    typeof entry.limit?.output === "number" && entry.limit.output > 0,
    "output must be derived when no member declares max_output_tokens"
  );
});

test("LCD: combo output is the MIN of member outputs when declared", () => {
  const resolved = resolveOmniRoutePluginOptions({ providerId: "omniroute" });
  const rawModels = [
    fullModel("big", 200_000, 64_000),
    fullModel("small", 8_000, 4_000),
  ];
  const rawCombos = [
    combo("my-combo", "MyCombo", [
      { id: "m1", kind: "model", model: "big", weight: 100 },
      { id: "m2", kind: "model", model: "small", weight: 80 },
    ]),
  ];
  const block = buildStaticProviderEntry(rawModels, rawCombos, resolved, BASE, "sk-test");
  const entry = byName(block, "MyCombo");
  assert.equal(entry.limit?.context, 8_000);
  assert.equal(entry.limit?.output, 4_000, "min of member outputs when all declare it");
});

// ────────────────────────────────────────────────────────────────────────────
// 3. Nested combo-refs — min propagates through the graph even without outputs
// ────────────────────────────────────────────────────────────────────────────

test("LCD: nested combo-ref without outputs propagates the min to the parent", () => {
  const resolved = resolveOmniRoutePluginOptions({ providerId: "omniroute" });
  const rawModels = [
    ctxOnlyModel("raw-big", 200_000),
    ctxOnlyModel("raw-tiny", 8_000),
  ];
  const rawCombos = [
    combo("tiny-combo", "TinyCombo", [{ id: "m1", kind: "model", model: "raw-tiny", weight: 100 }]),
    combo("parent", "Parent", [
      { id: "p1", kind: "model", model: "raw-big", weight: 50 },
      { id: "p2", kind: "combo-ref", comboName: "TinyCombo", weight: 50 },
    ]),
  ];
  const block = buildStaticProviderEntry(rawModels, rawCombos, resolved, BASE, "sk-test");
  const parent = byName(block, "Parent");
  assert.ok(parent, "Parent combo must be in the static catalog");
  assert.equal(parent.limit?.context, 8_000, "nested ref min (8_000) is the parent context");
  assert.ok(
    typeof parent.limit?.output === "number" && parent.limit.output > 0,
    "parent output must be derived when nested members lack max_output_tokens"
  );
});

test("LCD: deep nesting (ref inside ref) still yields the global min", () => {
  const resolved = resolveOmniRoutePluginOptions({ providerId: "omniroute" });
  const rawModels = [
    ctxOnlyModel("raw-huge", 1_000_000),
    ctxOnlyModel("raw-mid", 128_000),
    ctxOnlyModel("raw-tiny", 16_000),
  ];
  const rawCombos = [
    combo("mid-combo", "MidCombo", [{ id: "m1", kind: "model", model: "raw-mid", weight: 100 }]),
    combo("inner-combo", "InnerCombo", [
      { id: "m1", kind: "model", model: "raw-huge", weight: 50 },
      { id: "m2", kind: "combo-ref", comboName: "MidCombo", weight: 50 },
    ]),
    combo("outer-combo", "OuterCombo", [
      { id: "m1", kind: "model", model: "raw-tiny", weight: 100 },
      { id: "m2", kind: "combo-ref", comboName: "InnerCombo", weight: 50 },
    ]),
  ];
  const block = buildStaticProviderEntry(rawModels, rawCombos, resolved, BASE, "sk-test");
  const outer = byName(block, "OuterCombo");
  assert.ok(outer, "OuterCombo must be in the static catalog");
  assert.equal(outer.limit?.context, 16_000, "global min across two levels of nesting");
});

test("LCD: combo whose members are absent from /v1/models falls back to the upstream mirror raw entry", () => {
  // OmniRoute pre-mirrors combos into /v1/models under the friendly name
  // (e.g. id "STACK FREE" with context_length 32768). When the combo's
  // member ids are NOT resolvable against /v1/models (providers like
  // aihorde/felo-web not surfaced there), the mirror raw entry is the
  // upstream's own LCD answer — the combo must adopt it.
  const resolved = resolveOmniRoutePluginOptions({ providerId: "omniroute" });
  const rawModels = [ctxOnlyModel("STACK FREE", 32_768)];
  const rawCombos = [
    combo("stack-free", "STACK FREE", [
      { id: "m1", kind: "model", model: "aihorde/google/gemma-4-31b", weight: 0 },
      { id: "m2", kind: "model", model: "felo-web/felo-chat", weight: 0 },
    ]),
  ];
  const block = buildStaticProviderEntry(rawModels, rawCombos, resolved, BASE, "sk-test");
  const entry = byName(block, "STACK FREE");
  assert.ok(entry, "combo must be in the static catalog");
  assert.equal(entry.limit?.context, 32_768, "mirror raw context is the upstream LCD answer");
  assert.ok(
    typeof entry.limit?.output === "number" && entry.limit.output > 0,
    "output derived when mirror lacks max_output_tokens"
  );
});

test("LCD: combo with neither resolvable members nor a mirror raw emits NO limit", () => {
  const resolved = resolveOmniRoutePluginOptions({ providerId: "omniroute" });
  const block = buildStaticProviderEntry(
    [],
    [
      combo("ghost-combo", "GhostCombo", [
        { id: "m1", kind: "model", model: "nowhere/model", weight: 100 },
      ]),
    ],
    resolved,
    BASE,
    "sk-test"
  );
  const entry = byName(block, "GhostCombo");
  assert.ok(entry, "combo still enters the catalog");
  assert.equal(entry.limit, undefined, "no upstream data → no fabricated limit");
});

// ────────────────────────────────────────────────────────────────────────────
// 4. Constant sanity
// ────────────────────────────────────────────────────────────────────────────

test("LCD: FALLBACK_OUTPUT_TOKENS is exported and sane", () => {
  assert.equal(typeof FALLBACK_OUTPUT_TOKENS, "number");
  assert.ok(FALLBACK_OUTPUT_TOKENS > 0);
});
