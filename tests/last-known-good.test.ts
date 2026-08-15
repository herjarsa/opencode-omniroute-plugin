/**
 * Regression tests for the auto-sync model-loss bug.
 *
 * Root cause: `forceSyncOmniRouteModels` invalidated the in-memory cache and
 * DELETED the disk snapshot BEFORE fetching `/v1/models`. When that fetch
 * threw (timeout / 5xx) the cache was left empty and the snapshot gone; when
 * it returned an empty list (gateway 200 with non-parseable body) the cache
 * was overwritten with `rawModels: []` while combos/auto-combos stayed
 * populated — the picker then showed only "combos auto y customs" until the
 * next successful tick.
 *
 * Fix contract (last-known-good): never destroy or overwrite a good catalog
 * with a failed/empty refresh.
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
  noopDiskSnapshotReader,
modelsCacheKey,
type OmniRouteFetchCache,
type OmniRouteRawModelEntry,
} from "../src/index.js";

const BASE_URL = "https://or.example/v1";
const API_KEY = "sk-test";

const MODEL_CLAUDE: OmniRouteRawModelEntry = {
  id: "claude-sonnet-4-6",
  object: "model",
  context_length: 200_000,
  max_output_tokens: 8_192,
  capabilities: { reasoning: true, temperature: true, tool_calling: true },
};

const MODEL_GEMINI: OmniRouteRawModelEntry = {
  id: "gemini-2.5-pro",
  object: "model",
  context_length: 1_000_000,
  max_output_tokens: 65_536,
};

const readAuthJson = async () => ({
  omniroute: { type: "api" as const, key: API_KEY, baseURL: BASE_URL },
});

const resolvedForSync = (diskCache: boolean) =>
  resolveOmniRoutePluginOptions({
    providerId: "omniroute",
    baseURL: BASE_URL,
    autoSyncIntervalMs: 0,
    features: {
      combos: false,
      autoCombos: false,
      enrichment: false,
      compressionMetadata: false,
      usableOnly: false,
      diskCache,
    },
  });

/** Seed a cache entry under the same key forceSync will use. */
function seedCache(cache: OmniRouteFetchCache, models: OmniRouteRawModelEntry[]): string {
  const key = modelsCacheKey(BASE_URL, `${API_KEY}\0${API_KEY}`);
  cache.set(key, {
    rawModels: models,
    rawCombos: [],
    rawAutoCombos: [],
    rawEnrichment: new Map(),
    rawCompressionCombos: [],
    rawConnections: [],
    expiresAt: Date.now() + 300_000,
  });
  return key;
}

// ────────────────────────────────────────────────────────────────────────────
// S1. forceSync: fetcher throws → cache AND disk snapshot stay intact
// ────────────────────────────────────────────────────────────────────────────
test("forceSync: fetcher throws → preserves cache and disk snapshot", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-lkg-"));
  const previousDataDir = process.env.OPENCODE_DATA_DIR;
  process.env.OPENCODE_DATA_DIR = tmp;

  try {
    const resolved = resolvedForSync(true);
    // Write a last-known-good snapshot to disk.
    await defaultDiskSnapshotWriter(
      resolved.providerId,
      {
        rawModels: [MODEL_CLAUDE],
        rawCombos: [],
        rawAutoCombos: [],
        rawEnrichment: new Map(),
        rawCompressionCombos: [],
        rawConnections: [],
      },
      `${BASE_URL}::${API_KEY}`,
    );
    const pluginDir = path.join(tmp, "plugins");
    const snapshotFiles = () =>
      fs.existsSync(pluginDir) ? fs.readdirSync(pluginDir).filter((f) => f.endsWith(".json")) : [];

    const cache: OmniRouteFetchCache = new Map();
    const seededKey = seedCache(cache, [MODEL_CLAUDE]);
    const result = await forceSyncOmniRouteModels({
      resolved,
      cache,
      readAuthJson,
      fetcher: async () => {
        throw new Error("ECONNREFUSED");
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.clearedMemory, 0, "no cache entries cleared on failed fetch");
    assert.equal(result.clearedDisk, false, "disk snapshot not cleared on failed fetch");
    assert.ok(cache.get(seededKey), "in-memory last-known-good entry still present");
    assert.ok(snapshotFiles().length > 0, "disk snapshot file still present");
  } finally {
    if (previousDataDir === undefined) delete process.env.OPENCODE_DATA_DIR;
    else process.env.OPENCODE_DATA_DIR = previousDataDir;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// S2. forceSync: fetcher returns [] (gateway 200 w/ non-parseable body)
//     → previous catalog preserved, not overwritten with an empty one
// ────────────────────────────────────────────────────────────────────────────
test("forceSync: fetcher returns [] → preserves last-known-good catalog", async () => {
  const cache: OmniRouteFetchCache = new Map();
  const seededKey = seedCache(cache, [MODEL_CLAUDE, MODEL_GEMINI]);

  const result = await forceSyncOmniRouteModels({
    resolved: resolvedForSync(false),
    cache,
    readAuthJson,
    fetcher: async () => [],
  });

  assert.equal(result.ok, true);
  assert.equal(result.count, 0, "sync reports the fresh (empty) count");
  assert.equal(result.preserved, true, "sync flags that the previous catalog was kept");
  const seeded = cache.get(seededKey);
  assert.ok(seeded, "previous cache entry not overwritten");
  assert.equal(seeded.rawModels.length, 2, "previous models retained");
});

// ────────────────────────────────────────────────────────────────────────────
// S3. forceSync: fetcher returns new models → cache overwritten normally
// ────────────────────────────────────────────────────────────────────────────
test("forceSync: healthy fetch replaces the previous catalog", async () => {
  const cache: OmniRouteFetchCache = new Map();
  const seededKey = seedCache(cache, [MODEL_CLAUDE]);

  const result = await forceSyncOmniRouteModels({
    resolved: resolvedForSync(false),
    cache,
    readAuthJson,
    fetcher: async () => [MODEL_CLAUDE, MODEL_GEMINI],
  });

  assert.equal(result.ok, true);
  assert.equal(result.count, 2);
  assert.ok(!result.preserved);
  assert.equal(cache.size, 1, "seeded entry replaced by the fresh one");
  const entry = cache.get(seededKey);
  assert.ok(entry, "fresh entry written under the same key");
  assert.equal(entry.rawModels.length, 2);
});

// ────────────────────────────────────────────────────────────────────────────
// S4. provider hook: cache miss + fetcher returns [] → last-known-good reused
// ────────────────────────────────────────────────────────────────────────────
test("provider hook: empty fetch after TTL expiry keeps previous models", async () => {
  const cache: OmniRouteFetchCache = new Map();
  let calls = 0;
  const fetcher = async (): Promise<OmniRouteRawModelEntry[]> => {
    calls++;
    return calls === 1 ? [MODEL_CLAUDE] : [];
  };
  // Mutable clock so the second call lands after the default TTL (300000) has
  // expired and the hook is forced to re-fetch.
  let clock = 1_000;
  const now = () => clock;
  const hook = createOmniRouteProviderHook(
    {
      providerId: "omniroute",
      baseURL: BASE_URL,
      features: { combos: false, autoCombos: false, enrichment: false, providerTag: false },
    },
    { fetcher, cache, now, diskSnapshotReader: noopDiskSnapshotReader }
  );
  const provider = { options: { baseURL: BASE_URL } };
  const ctx = { auth: { type: "api", key: API_KEY } };

  const first = await hook.models(provider as never, ctx as never);
  clock = 1_000 + 300_001; // TTL expired
  const firstKeys = Object.keys(first);
  assert.ok(
    firstKeys.some((k) => k.endsWith("claude-sonnet-4-6")),
    "first call publishes the model"
  );

  // TTL (default 300000) has expired → hook re-fetches → gateway returns [].
  const second = await hook.models(provider as never, { ...ctx } as never);
  const secondKeys = Object.keys(second);
  assert.equal(calls, 2, "second call re-fetches (cache expired)");
  assert.ok(
    secondKeys.some((k) => k.endsWith("claude-sonnet-4-6")),
    "last-known-good model survives an empty refresh"
  );
});

// ────────────────────────────────────────────────────────────────────────────
// S5. config hook: fetcher returns [] (no throw) + disk snapshot available
//     → hydrate from snapshot instead of publishing an empty stub
// ────────────────────────────────────────────────────────────────────────────
test("config hook: empty fetch (no throw) hydrates from stale disk snapshot", async () => {
  const hook = createOmniRouteConfigHook(
    { providerId: "omniroute", baseURL: BASE_URL, features: { diskCache: true, enrichment: false, autoCombos: false } },
    {
      readAuthJson,
      fetcher: async () => [],
      combosFetcher: async () => [],
      diskSnapshotReader: async () => ({
        rawModels: [MODEL_CLAUDE],
        rawCombos: [],
        rawAutoCombos: [],
        rawEnrichment: new Map(),
        rawCompressionCombos: [],
        rawConnections: [],
      }),
      logger: { warn: () => {} },
    }
  );

  const input: { provider?: Record<string, unknown> } = {};
  await hook(input as never);

  const entry = (input as { provider: Record<string, unknown> }).provider?.[
    "opencode-omniroute"
  ] as { models: Record<string, unknown> };
  assert.ok(entry, "provider block published");
  assert.ok(
    entry.models["claude-sonnet-4-6"],
    "snapshot model hydrated even though the fetch returned [] without throwing"
  );
});
