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
  buildStaticProviderEntry,
  createOmniRouteProviderHook,
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

test("provider hook: auto-combo member is published even when usableOnly excludes its prefix", async () => {
  const hook = createOmniRouteProviderHook(
    {
      providerId: "omniroute",
      baseURL: "https://or.example.com/v1",
      modelCacheTtl: 60_000,
      features: {
        activeOnly: false,
        usableOnly: true,
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
      providersFetcher: async () => CONNECTION_KIRO_ONLY,
      activeModelsFetcher: async () => new Set(),
      diskSnapshotReader: noopDiskSnapshotReader,
    }
  );
  const out = await hook.models!({} as never, { auth: apiAuth("sk-x") as never });
  // `minimax` is known-but-not-usable → would be dropped by usableOnly; the
  // auto combo `auto/minimax` (pool [kiro, minimax]) must keep it published.
  assert.ok(
    out["minimax/MiniMax-M3"],
    "auto-combo member must be published despite usableOnly exclusion"
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
