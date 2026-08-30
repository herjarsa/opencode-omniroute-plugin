/**
 * Combo-member surfacing regression tests.
 *
 * Root cause (reported 2026-08-15): a published auto combo (`auto/minimax`)
 * expands server-side to concrete member models (`minimax/MiniMax-M3`,
 * `kr/minimax-m2.5`, …) via the family candidate filter. OpenCode then
 * validates the EXPANDED id (e.g. `opencode-omniroute/minimax/MiniMax-M3`)
 * against the provider's availableModels. When `activeOnly`/`usableOnly`
 * filter those members out of the published catalog, OpenCode raises
 * `ProviderModelNotFoundError: Model not found: … Did you mean: auto/minimax,
 * kr/minimax-m2.1, kr/minimax-m2.5?` even though the combo itself is
 * published and routable.
 *
 * Fix contract: every member of a PUBLISHED combo (DB combo member refs +
 * auto-combo candidatePool prefixes) that exists in the raw catalog MUST be
 * published in the provider catalog, exempt from activeOnly/usableOnly —
 * because the combo advertises those routes. Non-member models keep the
 * existing filter semantics (no picker pollution).
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildComboMemberPrefixes,
  buildStaticProviderEntry,
  createOmniRouteProviderHook,
  isValidProviderPrefix,
  noopDiskSnapshotReader,
  resolveOmniRoutePluginOptions,
  type OmniRouteEnrichmentMap,
  type OmniRouteProviderConnection,
  type OmniRouteRawAutoCombo,
  type OmniRouteRawCombo,
  type OmniRouteRawModelEntry,
} from "../src/index.js";

const apiAuth = (key: string, baseURL?: string): unknown => ({
  type: "api",
  key,
  ...(baseURL ? { baseURL } : {}),
});

// ── Fixtures ────────────────────────────────────────────────────────────

const MODEL_M3: OmniRouteRawModelEntry = {
  id: "minimax/MiniMax-M3",
  capabilities: { tool_calling: true, reasoning: true, temperature: true },
  context_length: 1_000_000,
  max_output_tokens: 384_000,
};

const MODEL_KR25: OmniRouteRawModelEntry = {
  id: "kr/minimax-m2.5",
  capabilities: { tool_calling: true, reasoning: true, temperature: true },
  context_length: 1_000_000,
  max_output_tokens: 384_000,
};

const MODEL_INACTIVE_NON_MEMBER: OmniRouteRawModelEntry = {
  id: "some/dead-model",
  capabilities: { tool_calling: false },
  context_length: 1_000,
};

const AUTO_MINIMAX: OmniRouteRawAutoCombo = {
  id: "auto/minimax",
  name: "Auto Minimax",
  candidatePool: ["kiro", "minimax"],
  candidateCount: 2,
};

const COMBO_DB_WITH_MEMBER: OmniRouteRawCombo = {
  id: "combo-m3",
  name: "M3 Combo",
  models: [{ kind: "model", model: "minimax/MiniMax-M3", weight: 100 }],
};

// Enrichment that marks BOTH `minimax` and `some` as KNOWN but NOT usable
// (usableOnly subtract-filter drops known-but-not-usable prefixes; the
// `minimax/MiniMax-M3` member is then re-published via combo-member surfacing).
function enrichmentWithMinimaxKnownNotUsable(): OmniRouteEnrichmentMap {
  const m = new Map<string, { providerAlias: string; providerCanonical: string }>();
  m.set("minimax/MiniMax-M3", { providerAlias: "minimax", providerCanonical: "minimax" });
  m.set("kr/minimax-m2.5", { providerAlias: "kr", providerCanonical: "kiro" });
  m.set("some/dead-model", { providerAlias: "some", providerCanonical: "some" });
  return m;
}

const CONNECTION_KIRO_ONLY: OmniRouteProviderConnection[] = [
  { id: "k1", provider: "kiro", isActive: true, testStatus: "active" },
];

// kiro is active+healthy (usableOnly keeps it); minimax is active but
// testStatus=failed (usableOnly drops it as known-but-not-usable; enabledOnly
// keeps it because it ignores testStatus). This lets us assert that the
// combo-member carve-out fires for a prefix the operator has EXPLICITLY
// enabled — the post-audit security gate (audit 2026-08-30).
const CONNECTION_KIRO_AND_MINIMAX_FAILED: OmniRouteProviderConnection[] = [
  { id: "k1", provider: "kiro", isActive: true, testStatus: "active" },
  { id: "m1", provider: "minimax", isActive: true, testStatus: "failed" },
];

// minimax not connected at all → enabled.prefixes is missing "minimax" →
// the combo-member carve-out MUST NOT fire for the minimax prefix even if
// a combo references it. Tests the security gate that prevents an upstream-
// admin combo declaration from re-surfacing `isActive:false` providers.
const CONNECTION_KIRO_AND_MINIMAX_DISABLED: OmniRouteProviderConnection[] = [
  { id: "k1", provider: "kiro", isActive: true, testStatus: "active" },
  { id: "m2", provider: "minimax", isActive: false, testStatus: "active" },
];


// ── Dynamic provider hook ────────────────────────────────────────────────

test("provider hook: auto-combo member is published even when activeOnly excludes it", async () => {
  const hook = createOmniRouteProviderHook(
    {
      providerId: "omniroute",
      baseURL: "https://or.example.com/v1",
      modelCacheTtl: 60_000,
      features: {
        activeOnly: true,
        usableOnly: false,
        combos: false,
        autoCombos: true,
        enrichment: false,
        diskCache: false,
      },
    },
    {
      fetcher: async () => [MODEL_M3, MODEL_KR25, MODEL_INACTIVE_NON_MEMBER],
      combosFetcher: async () => [],
      autoCombosFetcher: async () => [AUTO_MINIMAX],
      enrichmentFetcher: async () => new Map(),
      providersFetcher: async () => [],
      activeModelsFetcher: async () => new Set(["kr/minimax-m2.5"]),
      diskSnapshotReader: noopDiskSnapshotReader,
    }
  );
  const out = await hook.models!({} as never, { auth: apiAuth("sk-x") as never });
  assert.ok(
    out["minimax/MiniMax-M3"],
    "auto-combo member must be published despite activeOnly exclusion"
  );
  assert.ok(out["kr/minimax-m2.5"], "active model still published");
  assert.ok(!out["some/dead-model"], "non-member inactive model still excluded");
});

test("provider hook: auto-combo member is published when usableOnly excludes but enabledOnly allows it", async () => {
  const hook = createOmniRouteProviderHook(
    {
      providerId: "omniroute",
      baseURL: "https://or.example.com/v1",
      modelCacheTtl: 60_000,
      features: {
        activeOnly: false,
        usableOnly: true,
        // enabledOnly is default ON. minimax is isActive=true (so it's in the
        // operator's enabled set) even though its connection testStatus=failed
        // drops it from usableOnly. The combo-member carve-out should fire for
        // the "minimax" prefix because it's in enabled.prefixes.
        combos: false,
        autoCombos: true,
        enrichment: true,
        diskCache: false,
      },
    },
    {
      fetcher: async () => [MODEL_M3, MODEL_KR25, MODEL_INACTIVE_NON_MEMBER],
      combosFetcher: async () => [],
      autoCombosFetcher: async () => [AUTO_MINIMAX],
      enrichmentFetcher: async () => enrichmentWithMinimaxKnownNotUsable(),
      providersFetcher: async () => CONNECTION_KIRO_AND_MINIMAX_FAILED,
      activeModelsFetcher: async () => new Set(),
      diskSnapshotReader: noopDiskSnapshotReader,
    }
  );
  const out = await hook.models!({} as never, { auth: apiAuth("sk-x") as never });
  // `minimax` is known-but-not-usable (testStatus=failed) → would be dropped
  // by usableOnly. enabledOnly keeps it (ignores testStatus). The combo
  // member carve-out fires because "minimax" is in the operator's
  // enabled.prefixes, so the model survives both filters.
  assert.ok(
    out["minimax/MiniMax-M3"],
    "auto-combo member kept by enabledOnly-anchored carve-out despite usableOnly exclusion"
  );
  assert.ok(out["kr/minimax-m2.5"], "kiro member (usable canonical) still published");
  assert.ok(!out["some/dead-model"], "non-member known-but-unusable model still excluded");
});

test("provider hook: DB combo member ref is published even when activeOnly excludes it", async () => {
  const hook = createOmniRouteProviderHook(
    {
      providerId: "omniroute",
      baseURL: "https://or.example.com/v1",
      modelCacheTtl: 60_000,
      features: {
        activeOnly: true,
        usableOnly: false,
        combos: true,
        autoCombos: false,
        enrichment: false,
        diskCache: false,
      },
    },
    {
      fetcher: async () => [MODEL_M3, MODEL_KR25, MODEL_INACTIVE_NON_MEMBER],
      combosFetcher: async () => [COMBO_DB_WITH_MEMBER],
      autoCombosFetcher: async () => [],
      enrichmentFetcher: async () => new Map(),
      providersFetcher: async () => [],
      activeModelsFetcher: async () => new Set(["kr/minimax-m2.5"]),
      diskSnapshotReader: noopDiskSnapshotReader,
    }
  );
  const out = await hook.models!({} as never, { auth: apiAuth("sk-x") as never });
  assert.ok(
    out["minimax/MiniMax-M3"],
    "DB combo member ref must be published despite activeOnly exclusion"
  );
  assert.ok(out["kr/minimax-m2.5"], "active model still published");
  assert.ok(!out["some/dead-model"], "non-member inactive model still excluded");
});

// ── Static catalog (config hook) ─────────────────────────────────────────

test("static provider entry: auto-combo member is published despite activeOnly", () => {
  const resolved = resolveOmniRoutePluginOptions({
    providerId: "omniroute",
    baseURL: "https://or.example.com/v1",
    features: {
      activeOnly: true,
      usableOnly: false,
      combos: false,
      autoCombos: true,
      enrichment: false,
      diskCache: false,
    },
  });
  const block = buildStaticProviderEntry(
    [MODEL_M3, MODEL_KR25, MODEL_INACTIVE_NON_MEMBER],
    [],
    resolved,
    "https://or.example.com/v1",
    "sk-x",
    undefined,
    undefined,
    undefined,
    [AUTO_MINIMAX],
    new Set(["kr/minimax-m2.5"])
  );
  assert.ok(
    block.models["minimax/MiniMax-M3"],
    "static catalog must publish auto-combo member despite activeOnly exclusion"
  );
  assert.ok(block.models["kr/minimax-m2.5"], "active model still published");
  assert.ok(!block.models["some/dead-model"], "non-member inactive model still excluded");
});

test("static provider entry: DB combo member ref is published despite activeOnly", () => {
  const resolved = resolveOmniRoutePluginOptions({
    providerId: "omniroute",
    baseURL: "https://or.example.com/v1",
    features: {
      activeOnly: true,
      usableOnly: false,
      combos: true,
      autoCombos: false,
      enrichment: false,
      diskCache: false,
    },
  });
  const block = buildStaticProviderEntry(
    [MODEL_M3, MODEL_KR25, MODEL_INACTIVE_NON_MEMBER],
    [COMBO_DB_WITH_MEMBER],
    resolved,
    "https://or.example.com/v1",
    "sk-x",
    undefined,
    undefined,
    undefined,
    [],
    new Set(["kr/minimax-m2.5"])
  );
  assert.ok(
    block.models["minimax/MiniMax-M3"],
    "static catalog must publish DB combo member ref despite activeOnly exclusion"
  );
  assert.ok(!block.models["some/dead-model"], "non-member inactive model still excluded");
});


// ── Security gate (audit 2026-08-30) ──────────────────────────────────────────
// The combo-member carve-out only fires for prefixes the operator has EXPLICITLY
// enabled. If a published combo references a provider the operator has not
// enabled (e.g. via the OmniRoute dashboard isActive:false toggle), the
// member models stay dropped so the picker does not leak disabled-provider
// models via an upstream-admin combo declaration.

test("provider hook: combo member with disabled provider prefix is dropped (security gate)", async () => {
  const hook = createOmniRouteProviderHook(
    {
      providerId: "omniroute",
      baseURL: "https://or.example.com/v1",
      modelCacheTtl: 60_000,
      features: {
        activeOnly: true,
        usableOnly: false,
        // enabledOnly is default ON. minimax is isActive:false in this
        // fixture — so it's NOT in the operator's enabled.prefixes. Even
        // though the auto combo `auto/minimax` references it, the
        // combo-member carve-out MUST NOT re-surface it (security gate).
        combos: false,
        autoCombos: true,
        enrichment: true,
        diskCache: false,
      },
    },
    {
      fetcher: async () => [MODEL_M3, MODEL_KR25, MODEL_INACTIVE_NON_MEMBER],
      combosFetcher: async () => [],
      autoCombosFetcher: async () => [AUTO_MINIMAX],
      enrichmentFetcher: async () => enrichmentWithMinimaxKnownNotUsable(),
      providersFetcher: async () => CONNECTION_KIRO_AND_MINIMAX_DISABLED,
      activeModelsFetcher: async () => new Set(["kr/minimax-m2.5"]),
      diskSnapshotReader: noopDiskSnapshotReader,
    }
  );
  const out = await hook.models!({} as never, { auth: apiAuth("sk-x") as never });
  // minimax is isActive:false and in enabledOnly.knownAliases (from
  // enrichment) but NOT in enabledOnly.prefixes — usableOnly: false
  // skips, enabledOnly drops, security gate blocks the carve-out.
  assert.equal(
    out["minimax/MiniMax-M3"],
    undefined,
    "combo member with disabled provider must NOT be re-published (security gate)"
  );
  // kiro is active+active — in enabledOnly.prefixes, kept normally.
  assert.ok(out["kr/minimax-m2.5"], "active member on enabled provider still published");
});

test("static catalog: combo member with disabled provider prefix is dropped (security gate)", () => {
  const resolved = resolveOmniRoutePluginOptions({
    providerId: "omniroute",
    baseURL: "https://or.example.com/v1",
    features: {
      activeOnly: true,
      usableOnly: false,
      combos: false,
      autoCombos: true,
      enrichment: true,
      diskCache: false,
    },
  });
  const block = buildStaticProviderEntry(
    [MODEL_M3, MODEL_KR25, MODEL_INACTIVE_NON_MEMBER],
    [],
    resolved,
    "https://or.example.com/v1",
    "sk-x",
    enrichmentWithMinimaxKnownNotUsable(),
    undefined,
    CONNECTION_KIRO_AND_MINIMAX_DISABLED,
    [AUTO_MINIMAX],
    new Set(["kr/minimax-m2.5"])
  );
  assert.equal(
    block.models["minimax/MiniMax-M3"],
    undefined,
    "static catalog must NOT re-publish disabled-provider combo member"
  );
  assert.ok(block.models["kr/minimax-m2.5"], "active member on enabled provider still published");
});

// ── Prefix validation (audit 2026-08-30) ──────────────────────────────────
// buildComboMemberPrefixes must reject malformed prefixes (uppercase, special
// chars, empty, overlong, leading hyphen) so typos in `candidatePool` or
// `combo.models[].model` don't widen the filter bypass.

test("buildComboMemberPrefixes: accepts well-formed lowercase prefixes", () => {
  const prefixes = buildComboMemberPrefixes(
    [
      { id: "c1", name: "test", models: [
        { kind: "model", model: "kc/foo" },
        { kind: "model", model: "openrouter/bar" },
        { kind: "model", model: "opencode-zen/baz" },
        { kind: "model", model: "openai-compatible-chat-9d3a/baz" },
        { kind: "model", model: "123abc/qux" },
      ]},
    ],
    [{ id: "a1", candidatePool: ["kilo", "kc", "kr", "1a", "x-y-1"] }]
  );
  assert.deepStrictEqual(
    [...prefixes].sort(),
    ["1a", "123abc", "kc", "kilo", "kr", "openai-compatible-chat-9d3a", "opencode-zen", "openrouter", "x-y-1"].sort()
  );
});

test("buildComboMemberPrefixes: rejects malformed prefixes (typo / injection guard)", () => {
  const prefixes = buildComboMemberPrefixes(
    [
      { id: "c1", name: "test", models: [
        { kind: "model", model: "GOOD/foo" },
        { kind: "model", model: "BAD/Foo" },          // uppercase — rejected
        { kind: "model", model: "with space/x" },    // whitespace — rejected
        { kind: "model", model: "slash/in/x" },      // prefix "slash" is valid (lowercase) — accepted
        { kind: "model", model: "noslash" },         // no slash — rejected
        { kind: "model", model: "" },                 // empty — rejected
        { kind: "model", model: "-leading-hyphen/x" }, // leading hyphen — rejected
        { kind: "model", model: `${"x".repeat(60)}/y` }, // overlong — rejected
        { kind: "model", model: "special!char/x" },  // special char — rejected
      ]},
    ],
    [{ id: "a2", candidatePool: ["UPPER", "with space", "-leading", "", "good"] }]
  );
  assert.deepStrictEqual([...prefixes].sort(), ["good", "slash"].sort());
});

test("isValidProviderPrefix: matches buildComboMemberPrefixes accepted set", () => {
  // Valid examples (lowercase, digits, hyphens, 1-50 chars, alphanumeric first char)
  assert.equal(isValidProviderPrefix("kc"), true);
  assert.equal(isValidProviderPrefix("openrouter"), true);
  assert.equal(isValidProviderPrefix("opencode-zen"), true);
  assert.equal(isValidProviderPrefix("openai-compatible-chat-9d3a"), true);
  assert.equal(isValidProviderPrefix("1a"), true);
  assert.equal(isValidProviderPrefix("a1b2c3"), true);
  // Invalid examples
  assert.equal(isValidProviderPrefix(""), false);
  assert.equal(isValidProviderPrefix("UPPER"), false);
  assert.equal(isValidProviderPrefix("with space"), false);
  assert.equal(isValidProviderPrefix("-leading-hyphen"), false);
  assert.equal(isValidProviderPrefix("special!char"), false);
  assert.equal(isValidProviderPrefix("a/b"), false); // slash not allowed
  assert.equal(isValidProviderPrefix(`${"x".repeat(51)}`), false); // overlong
  assert.equal(isValidProviderPrefix(`${"x".repeat(50)}`), true); // exactly at limit
});
