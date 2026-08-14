/**
 * Regression tests: features.activeOnly + auto-sync consistency.
 *
 * Root cause (empirical, reproduced against the live gateway):
 * `forceSyncOmniRouteModels` wrote the shared cache WITHOUT `activeModelIds`,
 * so after every auto-sync tick the provider hook read an empty active-set,
 * the `size > 0` guard disabled the filter, and the picker flipped from the
 * filtered catalog (57 entries) to the full catalog (830) — alternating every
 * TTL/auto-sync cycle. Sub-agents with models assigned from the filtered
 * catalog then hit "Model not found" when the list shrank back.
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
  type OmniRouteFetchCache,
  type OmniRouteRawModelEntry,
} from "../src/index.js";

const BASE_URL = "https://or.example/v1";
const API_KEY = "sk-test";

const MODEL_A: OmniRouteRawModelEntry = {
  id: "cc/claude-x",
  object: "model",
  context_length: 200_000,
  max_output_tokens: 8_192,
  capabilities: { reasoning: true, temperature: true, tool_calling: true },
};
const MODEL_B: OmniRouteRawModelEntry = {
  id: "kr/gemini-y",
  object: "model",
  context_length: 1_000_000,
  max_output_tokens: 65_536,
};

const readAuthJson = async () => ({
  omniroute: { type: "api" as const, key: API_KEY, baseURL: BASE_URL },
});

const resolvedActiveOnly = (diskCache: boolean) =>
  resolveOmniRoutePluginOptions({
    providerId: "omniroute",
    baseURL: BASE_URL,
    autoSyncIntervalMs: 0,
    features: {
      activeOnly: true,
      combos: false,
      autoCombos: false,
      enrichment: false,
      compressionMetadata: false,
      usableOnly: false,
      diskCache,
    },
  });

const activeFetcher = async () => new Set(["cc/claude-x"]);
const throwingActiveFetcher = async (): Promise<Set<string>> => {
  throw new Error("/api/models 500");
};

// ────────────────────────────────────────────────────────────────────────────
// T1. forceSync with activeOnly writes activeModelIds into the cache
// ────────────────────────────────────────────────────────────────────────────
test("forceSync: activeOnly=true stores activeModelIds in the cache entry", async () => {
  const cache: OmniRouteFetchCache = new Map();
  const result = await forceSyncOmniRouteModels({
    resolved: resolvedActiveOnly(false),
    cache,
    readAuthJson,
    fetcher: async () => [MODEL_A, MODEL_B],
    activeModelsFetcher: activeFetcher,
  });

  assert.equal(result.ok, true);
  const entry = [...cache.values()][0];
  assert.ok(entry, "cache entry written");
  assert.ok(entry.activeModelIds, "entry carries an active-model set");
  assert.ok(entry.activeModelIds.has("cc/claude-x"), "active id preserved");
  assert.equal(entry.activeModelIds.has("kr/gemini-y"), false, "inactive id excluded");
});

// ────────────────────────────────────────────────────────────────────────────
// T2. forceSync active-models fetch failure → empty set (filter disabled),
//     never a broken entry
// ────────────────────────────────────────────────────────────────────────────
test("forceSync: active-models fetch throws → entry keeps empty set", async () => {
  const cache: OmniRouteFetchCache = new Map();
  const result = await forceSyncOmniRouteModels({
    resolved: resolvedActiveOnly(false),
    cache,
    readAuthJson,
    fetcher: async () => [MODEL_A, MODEL_B],
    activeModelsFetcher: throwingActiveFetcher,
  });

  assert.equal(result.ok, true);
  const entry = [...cache.values()][0];
  assert.ok(entry?.activeModelIds, "activeModelIds present even on soft-fail");
  assert.equal(entry.activeModelIds.size, 0, "empty set → filter disabled for refresh");
});

// ────────────────────────────────────────────────────────────────────────────
// T3. Disk snapshot round-trips activeModelIds
// ────────────────────────────────────────────────────────────────────────────
test("snapshot: activeModelIds survive writer → reader round-trip", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-active-snap-"));
  const previousDataDir = process.env.OPENCODE_DATA_DIR;
  process.env.OPENCODE_DATA_DIR = tmp;

  try {
    const fp = "identity-fingerprint";
    await defaultDiskSnapshotWriter(
      "omniroute",
      {
        rawModels: [MODEL_A, MODEL_B],
        rawCombos: [],
        rawAutoCombos: [],
        rawEnrichment: new Map(),
        rawCompressionCombos: [],
        rawConnections: [],
        activeModelIds: new Set(["cc/claude-x"]),
      },
      fp
    );
    const read = await defaultDiskSnapshotReader("omniroute", fp);
    assert.ok(read, "snapshot readable");
    assert.ok(read.activeModelIds, "activeModelIds restored from disk");
    assert.ok(read.activeModelIds.has("cc/claude-x"), "active id survives round-trip");
    assert.equal(read.activeModelIds.has("kr/gemini-y"), false, "inactive id not invented");
  } finally {
    if (previousDataDir === undefined) delete process.env.OPENCODE_DATA_DIR;
    else process.env.OPENCODE_DATA_DIR = previousDataDir;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// T4. config hook disk fallback restores activeModelIds from the snapshot
//     (empty live fetch + stale snapshot with active ids → filtered block)
// ────────────────────────────────────────────────────────────────────────────
test("config hook: stale snapshot with activeModelIds filters the static block", async () => {
  const hook = createOmniRouteConfigHook(
    {
      providerId: "omniroute",
      baseURL: BASE_URL,
      features: { diskCache: true, enrichment: false, autoCombos: false, activeOnly: true },
    },
    {
      readAuthJson,
      fetcher: async () => [],
      combosFetcher: async () => [],
      diskSnapshotReader: async () => ({
        rawModels: [MODEL_A, MODEL_B],
        rawCombos: [],
        rawAutoCombos: [],
        rawEnrichment: new Map(),
        rawCompressionCombos: [],
        rawConnections: [],
        activeModelIds: new Set(["cc/claude-x"]),
      }),
      logger: { warn: () => {} },
    }
  );

  const input: { provider?: Record<string, unknown> } = {};
  await hook(input as never);

  const entry = (input as { provider: Record<string, unknown> }).provider?.[
    "opencode-omniroute"
  ] as { models: Record<string, unknown> };
  assert.ok(entry, "static block published");
  assert.ok(entry.models["cc/claude-x"], "active model hydrated from snapshot");
  assert.equal(
    entry.models["kr/gemini-y"],
    undefined,
    "inactive model filtered out via snapshot active ids"
  );
});

// ────────────────────────────────────────────────────────────────────────────
// T5. Picker stays stable across forceSync: after the auto-sync writes the
//     cache, the next provider.models() call still filters (no 830↔57 flip)
// ────────────────────────────────────────────────────────────────────────────
test("provider hook: catalog stable after forceSync with activeOnly", async () => {
  const cache: OmniRouteFetchCache = new Map();
  let clock = 1_000;
  const now = () => clock;
  const hook = createOmniRouteProviderHook(
    {
      providerId: "omniroute",
      baseURL: BASE_URL,
      features: {
        activeOnly: true,
        combos: false,
        autoCombos: false,
        enrichment: false,
        providerTag: false,
      },
    },
    { fetcher: async () => [MODEL_A, MODEL_B], activeModelsFetcher: activeFetcher, cache, now }
  );
  const provider = { options: { baseURL: BASE_URL } };
  const ctx = { auth: { type: "api", key: API_KEY } };

  // 1. Cold call: cache miss → full refetch → filtered to active ids.
  const first = await hook.models(provider as never, ctx as never);
  assert.ok(first["cc/claude-x"], "active model present on cold start");
  assert.equal(first["kr/gemini-y"], undefined, "inactive model filtered on cold start");

  // 2. forceSync (auto-sync) refreshes the shared cache.
  const sync = await forceSyncOmniRouteModels({
    resolved: resolvedActiveOnly(false),
    cache,
    readAuthJson,
    fetcher: async () => [MODEL_A, MODEL_B],
    activeModelsFetcher: activeFetcher,
  });
  assert.equal(sync.ok, true);

  // 3. Cache hit after auto-sync must still be filtered — the catalog must
  //    NOT flip back to the full 830-style list.
  clock = 1_000 + 10_000; // inside TTL → cache hit
  const after = await hook.models(provider as never, ctx as never);
  assert.ok(after["cc/claude-x"], "active model still present after forceSync");
  assert.equal(
    after["kr/gemini-y"],
    undefined,
    "inactive model still filtered after forceSync (no catalog flip)"
  );
});
