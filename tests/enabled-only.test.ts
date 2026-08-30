/**
 * Regression tests for `features.enabledOnly` — opt-in provider-level
 * active-only filter.
 *
 * Difference vs `usableOnly` (the closest neighbour):
 *   - `usableOnly` requires `isActive: true && testStatus === "active"`
 *   - `enabledOnly` requires ONLY `isActive: true` — providers that are
 *     active but failing connection tests still surface their models.
 *
 * User motivation: providers in OmniRoute's dashboard can be enabled/
 * disabled independently. Operators want the model picker to mirror the
 * dashboard toggle (the `isActive` switch) without being coupled to the
 * transient `testStatus` (which can be `unavailable` for a rate-limited
 * or temporarily-broken provider the operator still wants visible).
 *
 * Combos pass through unchanged — they have no enable/disable in the
 * OmniRoute dashboard, so the picker always surfaces them when
 * `features.combos !== false`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  resolveOmniRoutePluginOptions,
  forceSyncOmniRouteModels,
  createOmniRouteProviderHook,
  createOmniRouteConfigHook,
  defaultDiskSnapshotWriter,
  defaultDiskSnapshotReader,
  noopDiskSnapshotReader,
  type OmniRouteFetchCache,
  type OmniRouteRawModelEntry,
  type OmniRouteProviderConnection,
  type OmniRouteEnrichmentMap,
  type OmniRouteEnrichmentEntry,
} from "../src/index.js";

const BASE_URL = "https://or.example/v1";
const API_KEY = "sk-test";

const MODEL_KC: OmniRouteRawModelEntry = {
  id: "kc/claude-opus-4-7",
  object: "model",
  context_length: 200_000,
  max_output_tokens: 8_192,
  capabilities: { reasoning: true, temperature: true, tool_calling: true },
};
const MODEL_KR: OmniRouteRawModelEntry = {
  id: "kr/gpt-5",
  object: "model",
  context_length: 200_000,
  max_output_tokens: 16_384,
};
const MODEL_M3: OmniRouteRawModelEntry = {
  id: "minimax/MiniMax-M3",
  object: "model",
  context_length: 1_000_000,
  max_output_tokens: 65_536,
};

const CONN_ACTIVE_KC: OmniRouteProviderConnection = {
  id: "kc1",
  provider: "kilocode",
  isActive: true,
  testStatus: "active",
};
const CONN_ACTIVE_KR: OmniRouteProviderConnection = {
  id: "kr1",
  provider: "kiro",
  isActive: true,
  testStatus: "active",
};
const CONN_ACTIVE_M3_FAILED: OmniRouteProviderConnection = {
  id: "m3-1",
  provider: "minimax",
  isActive: true,
  // Failed testStatus. usableOnly would DROP this provider. enabledOnly KEEPS it.
  testStatus: "expired",
};
const CONN_DISABLED_OPENROUTER: OmniRouteProviderConnection = {
  id: "or1",
  provider: "openrouter",
  isActive: false,
  testStatus: "active",
};

const readAuthJson = async () => ({
  omniroute: { type: "api" as const, key: API_KEY, baseURL: BASE_URL },
});

const resolvedEnabledOnly = (diskCache: boolean) =>
  resolveOmniRoutePluginOptions({
    providerId: "omniroute",
    baseURL: BASE_URL,
    autoSyncIntervalMs: 0,
    features: {
      enabledOnly: true,
      combos: false,
      autoCombos: false,
      enrichment: false,
      compressionMetadata: false,
      usableOnly: false,
      diskCache,
    },
  });

const providersFetcherAll = async (): Promise<OmniRouteProviderConnection[]> => [
  CONN_ACTIVE_KC,
  CONN_ACTIVE_KR,
  CONN_ACTIVE_M3_FAILED,
  CONN_DISABLED_OPENROUTER,
];

/**
 * Build a minimal OmniRouteEnrichmentMap that mirrors what
 * `defaultOmniRouteEnrichmentFetcher` would produce for the four providers
 * used in these tests. Required so `enabledProviderPrefixes` can expand
 * alias → canonical mappings (e.g. `kc` → `kilocode`) into the enabled set.
 * would be missing from the enabled set stored in the cache entry. Note:
 * since v0.2.22 the enabledOnly verdict is NEUTRALIZED —
 * `isEnabledRawModelId` returns true unconditionally so the picker shows
 * the full catalog; the set is still computed and round-tripped for
 * diagnostics and a future re-enable of the filter.
 */
function buildEnrichment(): OmniRouteEnrichmentMap {
  const m: OmniRouteEnrichmentMap = new Map();
  const entries: Array<{ id: string; providerAlias: string; providerCanonical: string }> = [
    { id: "kc/claude-opus-4-7", providerAlias: "kc", providerCanonical: "kilocode" },
    { id: "kr/gpt-5", providerAlias: "kr", providerCanonical: "kiro" },
    { id: "minimax/MiniMax-M3", providerAlias: "minimax", providerCanonical: "minimax" },
    { id: "openrouter/free-llama", providerAlias: "openrouter", providerCanonical: "openrouter" },
  ];
  for (const e of entries) {
    const entry: OmniRouteEnrichmentEntry = {
      providerAlias: e.providerAlias,
      providerCanonical: e.providerCanonical,
    };
    m.set(e.id, entry);
    m.set(`${e.providerAlias}/${e.id.split("/")[1]}`, entry);
  }
  return m;
}

// ─────────────────────────────────────────────────────────────────────────
// T1. forceSync with enabledOnly=true stores enabledProviderSet in cache
// ─────────────────────────────────────────────────────────────────────────
test("forceSync: enabledOnly=true stores enabledProviderSet in the cache entry", async () => {
  const cache: OmniRouteFetchCache = new Map();
  const result = await forceSyncOmniRouteModels({
    resolved: resolvedEnabledOnly(false),
    cache,
    readAuthJson,
    fetcher: async () => [MODEL_KC, MODEL_KR, MODEL_M3],
    providersFetcher: providersFetcherAll,
    activeModelsFetcher: async () => new Set([MODEL_KC.id, MODEL_KR.id, MODEL_M3.id]),
  });

  assert.equal(result.ok, true);
  const entry = [...cache.values()][0];
  assert.ok(entry, "cache entry written");
  assert.ok(entry.enabledProviderSet, "entry carries an enabled-provider set");
// All three active providers must be in the set, regardless of testStatus
  assert.ok(
    entry.enabledProviderSet!.prefixes.has("kilocode"),
    "active kc provider included",
  );
  assert.ok(
    entry.enabledProviderSet!.prefixes.has("kiro"),
    "active kr provider included",
  );
  assert.ok(
    entry.enabledProviderSet!.prefixes.has("minimax"),
    "active-but-failed-test m3 provider included (testStatus ignored)",
  );
  // Disabled provider must NOT be in the set
  assert.equal(
    entry.enabledProviderSet!.prefixes.has("openrouter"),
    false,
    "disabled openrouter excluded",
  );
});

// ─────────────────────────────────────────────────────────────────────────
// T2. testStatus does NOT affect enabledOnly (the key differentiator)
// ─────────────────────────────────────────────────────────────────────────
test("forceSync: provider with isActive=true but failed testStatus is included", async () => {
  const cache: OmniRouteFetchCache = new Map();
  await forceSyncOmniRouteModels({
    resolved: resolvedEnabledOnly(false),
    cache,
    readAuthJson,
    fetcher: async () => [MODEL_KC, MODEL_KR, MODEL_M3],
    providersFetcher: providersFetcherAll,
    activeModelsFetcher: async () => new Set([MODEL_KC.id, MODEL_KR.id, MODEL_M3.id]),
  });
const entry = [...cache.values()][0];
  assert.ok(entry?.enabledProviderSet, "enabledProviderSet present");
  // minimax testStatus is "expired" but isActive is true — must be kept
  assert.ok(
    entry!.enabledProviderSet!.prefixes.has("minimax"),
    "active+failed-test provider kept by enabledOnly",
  );
  });

// ─────────────────────────────────────────────────────────────────────────
// T3. Soft-fail: empty connections → filter disabled, all models pass
// ─────────────────────────────────────────────────────────────────────────
test("forceSync: empty connections → enabledProviderSet undefined, filter disabled", async () => {
  const cache: OmniRouteFetchCache = new Map();
  await forceSyncOmniRouteModels({
    resolved: resolvedEnabledOnly(false),
    cache,
    readAuthJson,
    fetcher: async () => [MODEL_KC, MODEL_KR, MODEL_M3],
    providersFetcher: async () => [],
  });

  const entry = [...cache.values()][0];
  // Empty connections → soft-fail: enabledProviderSet is undefined, filter
  // is disabled for the refresh — never hides the whole catalog.
  assert.equal(
    entry?.enabledProviderSet,
    undefined,
    "no enabled set when connections empty",
  );
});

// ─────────────────────────────────────────────────────────────────────────
// T4. Soft-fail: providersFetcher throws → enabledProviderSet undefined
// ─────────────────────────────────────────────────────────────────────────
test("forceSync: providersFetcher throws → enabledProviderSet undefined, filter disabled", async () => {
  const cache: OmniRouteFetchCache = new Map();
  await forceSyncOmniRouteModels({
    resolved: resolvedEnabledOnly(false),
    cache,
    readAuthJson,
    fetcher: async () => [MODEL_KC, MODEL_KR, MODEL_M3],
    providersFetcher: async () => {
      throw new Error("/api/providers 500");
    },
  });

  const entry = [...cache.values()][0];
  assert.equal(
    entry?.enabledProviderSet,
    undefined,
    "no enabled set when providersFetcher throws",
  );
});

// ─────────────────────────────────────────────────────────────────────────
// T5. Disk snapshot round-trips enabledProviderSet
// ─────────────────────────────────────────────────────────────────────────
test("snapshot: enabledProviderSet survives writer → reader round-trip", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-enabled-snap-"));
  const previousDataDir = process.env.OPENCODE_DATA_DIR;
  process.env.OPENCODE_DATA_DIR = tmp;

  try {
    const fp = "identity-fingerprint";
    await defaultDiskSnapshotWriter(
      "omniroute",
      {
        rawModels: [MODEL_KC, MODEL_KR, MODEL_M3],
        rawCombos: [],
        rawAutoCombos: [],
        rawEnrichment: new Map(),
        rawCompressionCombos: [],
        rawConnections: [],
        activeModelIds: new Set(),
        enabledProviderSet: { prefixes: new Set(["kilocode", "kiro", "minimax"]), knownAliases: new Set(["kilocode", "kiro", "minimax"]) },
      },
      fp
    );
    const read = await defaultDiskSnapshotReader("omniroute", fp);
    assert.ok(read, "snapshot readable");
    assert.ok(read?.enabledProviderSet, "enabledProviderSet restored from disk");
    assert.ok(
      read!.enabledProviderSet!.prefixes.has("kilocode"),
      "kilocode survives round-trip",
    );
    assert.ok(
      read!.enabledProviderSet!.prefixes.has("minimax"),
      "minimax survives round-trip",
    );
    assert.ok(
      !read!.enabledProviderSet!.prefixes.has("openrouter"),
      "openrouter not in enabled set",
    );
  } finally {
    if (previousDataDir === undefined) delete process.env.OPENCODE_DATA_DIR;
    else process.env.OPENCODE_DATA_DIR = previousDataDir;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// T6. Provider hook: catalog filtered by enabledOnly
// ─────────────────────────────────────────────────────────────────────────
test("provider hook: enabledOnly=true drops models of disabled providers", async () => {
  const cache: OmniRouteFetchCache = new Map();
  const hook = createOmniRouteProviderHook(
    {
      providerId: "omniroute",
      baseURL: BASE_URL,
      features: {
        enabledOnly: true,
        combos: false,
        autoCombos: false,
        enrichment: false,
        providerTag: false,
      },
    },
    {
      fetcher: async () => [MODEL_KC, MODEL_KR, MODEL_M3],
      providersFetcher: providersFetcherAll,
      enrichmentFetcher: async () => buildEnrichment(),
      cache,
      now: () => 1_000,
      diskSnapshotReader: noopDiskSnapshotReader,
    }
  );
  const provider = { options: { baseURL: BASE_URL } };
  const ctx = { auth: { type: "api", key: API_KEY } };

  const out = await hook.models(provider as never, ctx as never);
  // All three providers (kc, kr, minimax) are isActive:true → all kept.
  // The disabled openrouter has no models in the catalog so nothing to drop.
  assert.ok(out["kc/claude-opus-4-7"], "kc/ model kept (active)");
  assert.ok(out["kr/gpt-5"], "kr/ model kept (active)");
  assert.ok(
    out["minimax/MiniMax-M3"],
    "minimax/ model kept (active even though testStatus=expired)",
  );
});

// ─────────────────────────────────────────────────────────────────────────
// T7. Provider hook: enabledOnly drops models of disabled providers
// ─────────────────────────────────────────────────────────────────────────
test("provider hook: enabledOnly=true drops models of disabled providers", async () => {
  const MODEL_OR: OmniRouteRawModelEntry = {
    id: "openrouter/free-llama",
    object: "model",
    context_length: 8_000,
    max_output_tokens: 4_000,
  };
  const cache: OmniRouteFetchCache = new Map();
  const hook = createOmniRouteProviderHook(
    {
      providerId: "omniroute",
      baseURL: BASE_URL,
      features: {
        enabledOnly: true,
        combos: false,
        autoCombos: false,
        enrichment: false,
        providerTag: false,
      },
    },
    {
      fetcher: async () => [MODEL_KC, MODEL_OR],
      providersFetcher: async () => [CONN_ACTIVE_KC, CONN_DISABLED_OPENROUTER],
      enrichmentFetcher: async () => buildEnrichment(),
      cache,
      now: () => 1_000,
      diskSnapshotReader: noopDiskSnapshotReader,
    }
  );
  const provider = { options: { baseURL: BASE_URL } };
  const ctx = { auth: { type: "api", key: API_KEY } };

  const out = await hook.models(provider as never, ctx as never);
  assert.ok(out["kc/claude-opus-4-7"], "kc/ model kept (active provider)");
  assert.equal(
    out["openrouter/free-llama"],
    undefined,
    "openrouter/ model dropped (disabled provider)",
  );
});

// T8. Config hook: static block drops disabled-provider models with enabledOnly
// ─────────────────────────────────────────────────────────────────────────
test("config hook: enabledOnly=true drops disabled-provider models from static block", async () => {
  const MODEL_OR: OmniRouteRawModelEntry = {
    id: "openrouter/free-llama",
    object: "model",
    context_length: 8_000,
    max_output_tokens: 4_000,
  };
  // Isolate from any pre-existing disk snapshot so this test isn't coupled to
  // the operator's live `~/.local/share/opencode/plugins/omniroute-*.json`.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-enabled-only-cfg-"));
  const previousDataDir = process.env.OPENCODE_DATA_DIR;
  process.env.OPENCODE_DATA_DIR = tmp;
  try {
    const hook = createOmniRouteConfigHook(
      {
        providerId: "omniroute",
        baseURL: BASE_URL,
        features: { diskCache: true, enrichment: false, autoCombos: false, enabledOnly: true },
      },
      {
        readAuthJson,
        fetcher: async () => [MODEL_KC, MODEL_OR],
        combosFetcher: async () => [],
        providersFetcher: async () => [CONN_ACTIVE_KC, CONN_DISABLED_OPENROUTER],
        enrichmentFetcher: async () => buildEnrichment(),
        activeModelsFetcher: async () => new Set([MODEL_KC.id]),
        logger: { warn: () => {} },
      }
    );

    const input: { provider?: Record<string, unknown> } = {};
    await hook(input as never);

    const entry = (input as { provider: Record<string, unknown> }).provider?.[
      "opencode-omniroute"
    ] as { models: Record<string, unknown> };
    assert.ok(entry, "static block published");
    assert.ok(entry.models["kc/claude-opus-4-7"], "active-provider model present");
    assert.equal(
      entry.models["openrouter/free-llama"],
      undefined,
      "disabled-provider model dropped from static block",
    );
  } finally {
    if (previousDataDir === undefined) delete process.env.OPENCODE_DATA_DIR;
    else process.env.OPENCODE_DATA_DIR = previousDataDir;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// T9. Catalog stable after forceSync: filtered catalog persists (no flip)
// ─────────────────────────────────────────────────────────────────────────
test("provider hook: catalog stays filtered after forceSync with enabledOnly", async () => {
  const MODEL_OR: OmniRouteRawModelEntry = {
    id: "openrouter/free-llama",
    object: "model",
    context_length: 8_000,
    max_output_tokens: 4_000,
  };
  const cache: OmniRouteFetchCache = new Map();
  let clock = 1_000;
  const now = () => clock;
  const hook = createOmniRouteProviderHook(
    {
      providerId: "omniroute",
      baseURL: BASE_URL,
      features: {
        enabledOnly: true,
        combos: false,
        autoCombos: false,
        enrichment: false,
        providerTag: false,
      },
    },
    {
      fetcher: async () => [MODEL_KC, MODEL_OR],
      providersFetcher: async () => [CONN_ACTIVE_KC, CONN_DISABLED_OPENROUTER],
      enrichmentFetcher: async () => buildEnrichment(),
      activeModelsFetcher: async () => new Set([MODEL_KC.id]),
      cache,
      now,
      diskSnapshotReader: noopDiskSnapshotReader,
    }
  );
  const provider = { options: { baseURL: BASE_URL } };
  const ctx = { auth: { type: "api", key: API_KEY } };

  // 1. Cold call: cache miss → full refetch → disabled-provider models dropped.
  const first = await hook.models(provider as never, ctx as never);
  assert.ok(first["kc/claude-opus-4-7"], "active model present on cold start");
  assert.equal(
    first["openrouter/free-llama"],
    undefined,
    "disabled-provider model dropped on cold start",
  );

  // 2. forceSync refreshes the shared cache.
  const sync = await forceSyncOmniRouteModels({
    resolved: resolvedEnabledOnly(false),
    cache,
    readAuthJson,
    fetcher: async () => [MODEL_KC, MODEL_OR],
    providersFetcher: async () => [CONN_ACTIVE_KC, CONN_DISABLED_OPENROUTER],
    enrichmentFetcher: async () => buildEnrichment(),
  });
  assert.equal(sync.ok, true);

  // 3. Cache hit after forceSync must STILL drop the disabled-provider model —
  //    the catalog must NOT flip back to a full list.
  clock = 1_000 + 10_000; // inside TTL → cache hit
  const after = await hook.models(provider as never, ctx as never);
  assert.ok(after["kc/claude-opus-4-7"], "active model still present after forceSync");
  assert.equal(
    after["openrouter/free-llama"],
    undefined,
    "filtered catalog persists after forceSync (no flip back to full)",
  );
});

// ─────────────────────────────────────────────────────────────────────────
// T10. enabledOnly + usableOnly can coexist (intersection applies)
// ─────────────────────────────────────────────────────────────────────────
test("provider hook: enabledOnly and usableOnly both filter on top of each other", async () => {
  // kilocode is active + healthy → passes both filters
  // kiro is active but testStatus=failed → passes enabledOnly, fails usableOnly
  // minimax is active + healthy → passes both filters
  // openrouter is disabled → fails both filters
  const cache: OmniRouteFetchCache = new Map();
  const hook = createOmniRouteProviderHook(
    {
      providerId: "omniroute",
      baseURL: BASE_URL,
      features: {
        enabledOnly: true,
        usableOnly: true, // BOTH enabled — intersection should apply
        combos: false,
        autoCombos: false,
        enrichment: false,
        providerTag: false,
      },
    },
    {
      fetcher: async () => [MODEL_KC, MODEL_KR, MODEL_M3],
      providersFetcher: async () => [
        CONN_ACTIVE_KC,
        { ...CONN_ACTIVE_KR, testStatus: "failed" },
        { id: "m3-2", provider: "minimax", isActive: true, testStatus: "active" },
        CONN_DISABLED_OPENROUTER,
      ],
      enrichmentFetcher: async () => buildEnrichment(),
      cache,
      now: () => 1_000,
      diskSnapshotReader: noopDiskSnapshotReader,
    }
  );
  const provider = { options: { baseURL: BASE_URL } };
  const ctx = { auth: { type: "api", key: API_KEY } };

  const out = await hook.models(provider as never, ctx as never);
  // Both filters are active. usableOnly is stricter (requires active AND
  // healthy testStatus), so the intersection drops KR (active but failed test).
  // openrouter is disabled — enabledOnly would drop it; usableOnly also drops
  // it because it is not in the connections table at all.
  assert.ok(out["kc/claude-opus-4-7"], "kc kept (active + healthy)");
  assert.equal(
    out["kr/gpt-5"],
    undefined,
    "kr dropped by usableOnly intersection (active but failed test)",
  );
  assert.ok(out["minimax/MiniMax-M3"], "minimax kept (active + healthy)");
});
