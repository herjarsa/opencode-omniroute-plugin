/**
 * One-shot startup sync (onlyIfChanged) — replaces the periodic setInterval
 * auto-sync that caused `AbortError` (DOMException code 20) crashes in
 * bun's plugin runtime when the timer fired mid-shutdown.
 *
 * Contracts pinned here:
 *   1. onlyIfChanged + matching previous cache → unchanged:true, no side
 *      effects on cache or disk.
 *   2. onlyIfChanged + empty cache + matching disk snapshot → unchanged:true
 *      (simulates process restart that still has the prior snapshot).
 *   3. onlyIfChanged + different models → normal refresh, cache replaced.
 *   4. onlyIfChanged + rawModels.length===0 → falls through to the existing
 *      last-known-good guard (unchanged NOT set, preserved IS set).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveOmniRoutePluginOptions,
  forceSyncOmniRouteModels,
  runOmniRouteStartupSync,
  type OmniRouteFetchCache,
  type OmniRouteRawModelEntry,
  type OmniRouteDiskSnapshotReader,
} from "../src/index.js";
import assert from "node:assert/strict";
import {
  resolveOmniRoutePluginOptions,
  forceSyncOmniRouteModels,
  type OmniRouteFetchCache,
  type OmniRouteRawModelEntry,
  type OmniRouteDiskSnapshotReader,
} from "../src/index.js";

const BASE_URL = "https://or.example/v1";
const API_KEY = "sk-test";

const MODEL_A: OmniRouteRawModelEntry = { id: "cc/claude-x", object: "model" };
const MODEL_B: OmniRouteRawModelEntry = { id: "kr/gemini-y", object: "model" };
const MODEL_C: OmniRouteRawModelEntry = {
  id: "opencode/anthropic-z",
  object: "model",
};

const readAuthJson = async () => ({
  omniroute: { type: "api" as const, key: API_KEY, baseURL: BASE_URL },
});

const resolvedNoDisk = () =>
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
      diskCache: false,
    },
  });

const resolvedWithDisk = () =>
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
      diskCache: true,
    },
  });

test("onlyIfChanged: matching previous cache → unchanged:true, cache untouched", async () => {
  const cache: OmniRouteFetchCache = new Map();
  const resolved = resolvedNoDisk();
  const fresh = [MODEL_A, MODEL_B];

  // First sync to populate the cache.
  const first = await forceSyncOmniRouteModels({
    resolved,
    cache,
    readAuthJson,
    fetcher: async () => fresh,
    now: () => 1_000_000,
  });
  assert.equal(first.ok, true);
  assert.equal(first.count, 2);
  assert.equal(first.unchanged, undefined);

  // Second sync with onlyIfChanged:true and the SAME models.
  const second = await forceSyncOmniRouteModels({
    resolved,
    cache,
    readAuthJson,
    fetcher: async () => fresh,
    now: () => 2_000_000,
    onlyIfChanged: true,
  });
  assert.equal(second.ok, true);
  assert.equal(second.unchanged, true);
  assert.equal(second.count, 2);
  assert.equal(second.clearedMemory, 0);
  assert.equal(second.clearedDisk, false);
  // Cache should still hold the first entry's expiresAt (not overwritten).
  const entry = [...cache.values()][0];
  assert.equal(entry.expiresAt, 1_000_000 + resolved.modelCacheTtl);
  assert.equal(entry.rawModels.length, 2);
});

test("onlyIfChanged: empty cache + matching disk snapshot → unchanged:true (restart path)", async () => {
  const cache: OmniRouteFetchCache = new Map();
  const resolved = resolvedWithDisk();
  const fresh = [MODEL_A, MODEL_B];

  // Inject a reader that returns the same catalog the gateway would return.
  const reader: OmniRouteDiskSnapshotReader = async () => ({
    rawModels: fresh,
    rawCombos: [],
    rawAutoCombos: [],
    rawEnrichment: new Map(),
    rawCompressionCombos: [],
    rawConnections: [],
    activeModelIds: new Set(),
  });

  const result = await forceSyncOmniRouteModels({
    resolved,
    cache,
    readAuthJson,
    fetcher: async () => fresh,
    diskSnapshotReader: reader,
    now: () => 5_000_000,
    onlyIfChanged: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.unchanged, true);
  assert.equal(result.count, 2);
  assert.equal(result.clearedMemory, 0);
  assert.equal(result.clearedDisk, false);
  // Cache should remain cold — we did not write a new entry on unchanged.
  assert.equal(cache.size, 0);
});

test("onlyIfChanged: different models → normal refresh, cache replaced", async () => {
  const cache: OmniRouteFetchCache = new Map();
  const resolved = resolvedNoDisk();

  const first = await forceSyncOmniRouteModels({
    resolved,
    cache,
    readAuthJson,
    fetcher: async () => [MODEL_A],
    now: () => 1_000_000,
  });
  assert.equal(first.ok, true);
  assert.equal(first.count, 1);

  const second = await forceSyncOmniRouteModels({
    resolved,
    cache,
    readAuthJson,
    fetcher: async () => [MODEL_A, MODEL_B, MODEL_C],
    now: () => 2_000_000,
    onlyIfChanged: true,
  });
  assert.equal(second.ok, true);
  // unchanged is only set to true when the catalog matched; on a real change
  // it stays undefined so callers can distinguish "no-op" from "real refresh".
  assert.notEqual(second.unchanged, true);
  assert.equal(second.count, 3);
  assert.equal(second.clearedMemory, 1);
  // Cache should hold the new entry with the new catalog.
  const entry = [...cache.values()][0];
  assert.equal(entry.rawModels.length, 3);
  assert.deepEqual(
    entry.rawModels.map((m) => m.id).sort(),
    [MODEL_A.id, MODEL_B.id, MODEL_C.id].sort(),
  );
});

test("onlyIfChanged: rawModels.length===0 → falls through to last-known-good, unchanged NOT set", async () => {
  const cache: OmniRouteFetchCache = new Map();
  const resolved = resolvedNoDisk();

  // Pre-populate cache with a healthy catalog.
  const first = await forceSyncOmniRouteModels({
    resolved,
    cache,
    readAuthJson,
    fetcher: async () => [MODEL_A, MODEL_B],
    now: () => 1_000_000,
  });
  assert.equal(first.ok, true);
  assert.equal(first.count, 2);

  // Gateway returns 0 models. onlyIfChanged should NOT short-circuit
  // this — the existing last-known-good guard handles 0-model responses.
  const second = await forceSyncOmniRouteModels({
    resolved,
    cache,
    readAuthJson,
    fetcher: async () => [],
    now: () => 2_000_000,
    onlyIfChanged: true,
  });
  assert.equal(second.ok, true);
  assert.equal(second.preserved, true);
  assert.equal(second.unchanged, undefined);
  assert.equal(second.count, 0);
});

// ─────────────────────────────────────────────────────────────────────────
// runOmniRouteStartupSync scheduling contract (TDD RED for commit B)
// ─────────────────────────────────────────────────────────────────────────

test("runOmniRouteStartupSync: scheduler injected receives fn + default delay 2500 and executes once on ok:true", async () => {
  const cache: OmniRouteFetchCache = new Map();
  const resolved = resolvedNoDisk();
  let scheduledDelay: number | undefined;
  let scheduledFn: (() => void) | undefined;
  const scheduler = (fn: () => void, ms: number) => {
    scheduledFn = fn;
    scheduledDelay = ms;
  };
  let callCount = 0;
  const fakeSync = async () => {
    callCount++;
    return { ok: true as const, count: 1, combos: 0, clearedMemory: 0, clearedDisk: false, provider: resolved.providerId, baseURL: BASE_URL };
  };
  runOmniRouteStartupSync({ resolved, cache, scheduler, syncFn: fakeSync });
  assert.equal(scheduledDelay, 2500, "default initialDelayMs should be 2500");
  assert.ok(typeof scheduledFn === "function", "scheduler should receive a function");
  // Execute the scheduled fn and verify it calls sync once.
  await scheduledFn!();
  // Allow microtasks to settle.
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(callCount, 1, "sync should be called exactly once on ok:true");
});

test("runOmniRouteStartupSync: retries on ok:false up to maxAttempts with retryDelayMs", async () => {
  const cache: OmniRouteFetchCache = new Map();
  const resolved = resolvedNoDisk();
  const delays: number[] = [];
  const fns: Array<() => void> = [];
  const scheduler = (fn: () => void, ms: number) => {
    delays.push(ms);
    fns.push(fn);
  };
  let callCount = 0;
  const fakeSync = async () => {
    callCount++;
    return { ok: false as const, error: "boom", provider: resolved.providerId, baseURL: BASE_URL };
  };
  runOmniRouteStartupSync({ resolved, cache, scheduler, syncFn: fakeSync, initialDelayMs: 10, retryDelayMs: 50, maxAttempts: 3 });
  assert.equal(delays[0], 10, "first delay should be initialDelayMs");
  // First attempt failure should schedule a retry.
  await fns[0]();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(callCount, 1);
  assert.equal(delays.length, 2, "should have scheduled first retry");
  assert.equal(delays[1], 50, "retry delay should be retryDelayMs");
  await fns[1]();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(callCount, 2);
  assert.equal(delays.length, 3, "should have scheduled second retry");
  await fns[2]();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(callCount, 3, "should have retried up to maxAttempts=3");
  assert.equal(delays.length, 3, "no further retry after maxAttempts");
});

test("runOmniRouteStartupSync: thrown errors do not reject and trigger retry", async () => {
  const cache: OmniRouteFetchCache = new Map();
  const resolved = resolvedNoDisk();
  const delays: number[] = [];
  const fns: Array<() => void> = [];
  const scheduler = (fn: () => void, ms: number) => {
    delays.push(ms);
    fns.push(fn);
  };
  let callCount = 0;
  const fakeSync = async () => {
    callCount++;
    if (callCount < 3) throw new Error("transient");
    return { ok: true as const, count: 1, combos: 0, clearedMemory: 0, clearedDisk: false, provider: resolved.providerId, baseURL: BASE_URL };
  };
  // Should not throw synchronously.
  assert.doesNotThrow(() => {
    runOmniRouteStartupSync({ resolved, cache, scheduler, syncFn: fakeSync, initialDelayMs: 5, retryDelayMs: 20, maxAttempts: 3 });
  });
  await fns[0]();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(callCount, 1);
  assert.equal(delays.length, 2, "throw should schedule retry");
  await fns[1]();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(callCount, 2);
  assert.equal(delays.length, 3, "second throw should schedule retry");
  await fns[2]();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(callCount, 3, "third attempt should succeed");
  assert.equal(delays.length, 3, "no further retry after success");
});
