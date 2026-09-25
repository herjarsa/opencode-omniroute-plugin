/**
 * V2 (Desktop) compatibility tests.
 *
 * Covers `src/v2.ts`:
 *   - dual default export shape (`{ id, setup, server }`)
 *   - `modelV2KeyToV2ModelId` prefix normalization
 *   - `convertModelV2ToInfo` V1 ModelV2 → V2 Model.Info mapping
 *   - `extractV2ApiKey` credential-shape tolerance
 *   - `setupOmniRouteV2` against a stub host ctx (stub fetch + env key):
 *     provider/info/models registration, tool, commands, cleanup
 */

import test from "node:test";
import assert from "node:assert/strict";
import pluginDefault, {
  mapRawModelToModelV2,
  type OmniRouteRawModelEntry,
} from "../src/index.js";
import {
  OMNIROUTE_V2_PLUGIN_ID,
  OMNIROUTE_V2_PROVIDER_PACKAGE,
  convertModelV2ToInfo,
  extractV2ApiKey,
  modelV2KeyToV2ModelId,
  setupOmniRouteV2,
} from "../src/v2.js";

// ── Dual export shape ──────────────────────────────────────────────

test("default export exposes both V1 server() and V2 setup()", () => {
  const d = pluginDefault as unknown as Record<string, unknown>;
  assert.equal(d.id, OMNIROUTE_V2_PLUGIN_ID);
  assert.equal(typeof d.server, "function");
  assert.equal(typeof d.setup, "function");
});

// ── Key normalization ──────────────────────────────────────────────

test("modelV2KeyToV2ModelId strips only the owning-provider prefix", () => {
  assert.equal(modelV2KeyToV2ModelId("omniroute/MASTER", "omniroute"), "MASTER");
  assert.equal(modelV2KeyToV2ModelId("omniroute/bare-model", "omniroute"), "bare-model");
  assert.equal(
    modelV2KeyToV2ModelId("omniroute-preprod/SLUG", "omniroute-preprod"),
    "SLUG",
  );
  // Upstream namespaces survive verbatim.
  assert.equal(
    modelV2KeyToV2ModelId("cc/claude-opus-4-7", "omniroute"),
    "cc/claude-opus-4-7",
  );
  assert.equal(modelV2KeyToV2ModelId("auto/coding", "omniroute"), "auto/coding");
});

// ── ModelV2 → Model.Info conversion ────────────────────────────────

const RAW: OmniRouteRawModelEntry = {
  id: "cc/claude-opus-4-7",
  object: "model",
  owned_by: "claude",
  capabilities: { tool_calling: true, reasoning: true, vision: true, thinking: false },
  context_length: 200000,
  max_input_tokens: 180000,
  max_output_tokens: 32000,
  input_modalities: ["text", "image"],
  output_modalities: ["text"],
  release_date: "2026-01-15",
};

test("convertModelV2ToInfo maps capabilities/cost/limit/time", () => {
  const v1 = mapRawModelToModelV2(RAW, {
    providerId: "omniroute",
    baseURL: "https://or.example.com",
  });
  const info = convertModelV2ToInfo(v1, "omniroute", "omniroute");
  assert.equal(info.id, "cc/claude-opus-4-7");
  assert.equal(info.modelID, "cc/claude-opus-4-7");
  assert.equal(info.providerID, "omniroute");
  assert.equal(info.capabilities.tools, true);
  assert.deepEqual(info.capabilities.input, ["text", "image"]);
  assert.deepEqual(info.capabilities.output, ["text"]);
  assert.equal(info.limit.context, 200000);
  assert.equal(info.limit.input, 180000);
  assert.equal(info.limit.output, 32000);
  assert.equal(info.status, "active");
  assert.equal(info.enabled, true);
  assert.deepEqual(info.variants, []);
  assert.equal(info.time.released, Date.parse("2026-01-15"));
  assert.equal(info.cost.length, 1);
});

test("convertModelV2ToInfo strips owning prefix and defaults safely", () => {
  const v1 = mapRawModelToModelV2(
    { id: "bare-model", context_length: 0, max_output_tokens: 0 },
    { providerId: "omniroute", baseURL: "https://or.example.com" },
  );
  assert.equal(v1.id, "omniroute/bare-model");
  const info = convertModelV2ToInfo(v1, "omniroute-preprod", "omniroute");
  // The V1 owning prefix is stripped; the V2 providerID carries tenancy.
  assert.equal(info.id, "bare-model");
  assert.equal(info.providerID, "omniroute-preprod");
  const info2 = convertModelV2ToInfo(v1, "omniroute", "omniroute");
  assert.equal(info2.id, "bare-model");
  assert.deepEqual(info2.capabilities.input, ["text"]);
  assert.equal(info2.time.released, 0);
});

// ── Credential extraction ──────────────────────────────────────────

test("extractV2ApiKey tolerates host credential shapes", () => {
  assert.equal(extractV2ApiKey({ key: "k1" }), "k1");
  assert.equal(extractV2ApiKey({ apiKey: "k2" }), "k2");
  assert.equal(extractV2ApiKey({ token: "k3" }), "k3");
  assert.equal(extractV2ApiKey({ data: { key: "k4" } }), "k4");
  assert.equal(extractV2ApiKey(null), "");
  assert.equal(extractV2ApiKey("raw-string"), "");
});

// ── Full setup against a stub host ─────────────────────────────────

function stubResponse(url: string): Response {
  if (url.includes("/v1/models")) {
    const body = JSON.stringify({
      object: "list",
      data: [
        {
          id: "cc/claude-opus-4-7",
          capabilities: { tool_calling: true, reasoning: true, vision: false },
          context_length: 200000,
          max_output_tokens: 32000,
          input_modalities: ["text"],
          output_modalities: ["text"],
        },
        { id: "combo-mirror", context_length: 1000, max_output_tokens: 100 },
      ],
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response("not found", { status: 404 });
}

interface Captured {
  providers: Array<{ info: Record<string, unknown>; models: unknown[] }>;
  methods: unknown[];
  tools: Array<Record<string, unknown>>;
  commands: Array<Record<string, unknown>>;
  mcp: Array<[string, unknown]>;
  hooks: Array<{ name: string; opts: unknown }>;
}

function makeStubCtx(): { ctx: Record<string, unknown>; captured: Captured } {
  const captured: Captured = {
    providers: [],
    methods: [],
    tools: [],
    commands: [],
    mcp: [],
    hooks: [],
  };
  const ctx: Record<string, unknown> = {
    options: { providerId: "omniroute", baseURL: "https://or.example.com" },
    provider: {
      transform: async (cb: (e: unknown) => void) => {
        cb({
          add: (input: { info: Record<string, unknown>; models: unknown[] }) => {
            captured.providers.push(input);
          },
        });
        return { dispose: async () => {} };
      },
      reload: async () => {},
    },
    model: { reload: async () => {} },
    integration: {
      transform: async (cb: (e: unknown) => void) => {
        cb({
          method: {
            update: (input: unknown) => {
              captured.methods.push(input);
            },
          },
        });
        return { dispose: async () => {} };
      },
      connection: {
        active: async () => undefined,
        resolve: async () => undefined,
      },
    },
    tool: {
      transform: async (cb: (e: unknown) => void) => {
        cb({
          add: (tool: Record<string, unknown>) => {
            captured.tools.push(tool);
          },
        });
        return { dispose: async () => {} };
      },
    },
    command: {
      transform: async (cb: (e: unknown) => void) => {
        cb({
          add: (cmd: Record<string, unknown>) => {
            captured.commands.push(cmd);
          },
        });
        return { dispose: async () => {} };
      },
    },
    mcp: {
      transform: async (cb: (e: unknown) => void) => {
        cb({
          get: () => undefined,
          set: (name: string, config: unknown) => {
            captured.mcp.push([name, config]);
          },
        });
        return { dispose: async () => {} };
      },
    },
    session: {
      hook: async (name: string, _cb: unknown, opts: unknown) => {
        captured.hooks.push({ name: String(name), opts });
        return { dispose: async () => {} };
      },
    },
    event: {
      subscribe: async function* () {
        // No events — terminates immediately.
      },
    },
  };
  return { ctx, captured };
}

test("setupOmniRouteV2 registers provider, tool, commands on V2 host", async () => {
  const realFetch = globalThis.fetch;
  const prevKey = process.env.OMNIROUTE_API_KEY;
  process.env.OMNIROUTE_API_KEY = "test-key";
  (globalThis as { fetch?: unknown }).fetch = (async (input: unknown) => {
    const url = typeof input === "string" ? input : String((input as { url?: unknown }).url ?? input);
    return stubResponse(url);
  }) as typeof fetch;
  try {
    const { ctx, captured } = makeStubCtx();
    const cleanup = await setupOmniRouteV2(ctx);
    assert.equal(typeof cleanup, "function");

    // Provider registered with the V2 openai-compatible package.
    assert.equal(captured.providers.length, 1);
    const reg = captured.providers[0];
    const info = reg.info as Record<string, unknown>;
    assert.equal(info.id, "omniroute");
    assert.equal(info.package, OMNIROUTE_V2_PROVIDER_PACKAGE);
    assert.equal(info.integrationID, "omniroute");
    const settings = info.settings as Record<string, unknown>;
    assert.equal(settings.baseURL, "https://or.example.com/v1");
    assert.equal(settings.apiKey, "test-key");

    // Catalog converted: upstream namespace preserved, no double prefix.
    const models = reg.models as Array<Record<string, unknown>>;
    const ids = models.map((m) => m.id).sort();
    assert.ok(ids.includes("cc/claude-opus-4-7"), `ids: ${ids.join(",")}`);
    assert.ok(
      ids.every((id) => typeof id === "string" && !String(id).startsWith("omniroute/")),
      `no owning-prefix leak: ${ids.join(",")}`,
    );
    for (const m of models) {
      assert.equal(m.providerID, "omniroute");
      assert.equal((m as { modelID?: unknown }).modelID, m.id);
    }

    // Integration key method, sync tool, both commands, gemini hooks.
    assert.equal(captured.methods.length, 1);
    assert.equal(captured.tools.length, 1);
    assert.equal(captured.tools[0].name, "omniroute_sync_models");
    const cmdNames = captured.commands.map((c) => c.name).sort();
    assert.deepEqual(cmdNames, ["omni-autosync", "omni-sync"]);
    const hookNames = captured.hooks.map((h) => h.name).sort();
    assert.deepEqual(hookNames, ["compaction", "context", "generate"]);

    (cleanup as () => void)();
  } finally {
    (globalThis as { fetch?: unknown }).fetch = realFetch;
    if (prevKey === undefined) delete process.env.OMNIROUTE_API_KEY;
    else process.env.OMNIROUTE_API_KEY = prevKey;
  }
});

test("setupOmniRouteV2 without credentials registers provider shell + tooling", async () => {
  const prevKey = process.env.OMNIROUTE_API_KEY;
  const prevBase = process.env.OMNIROUTE_BASE_URL;
  delete process.env.OMNIROUTE_API_KEY;
  const { ctx, captured } = makeStubCtx();
  try {
    const cleanup = await setupOmniRouteV2(ctx);
    assert.equal(typeof cleanup, "function");
    // Provider shell registered (baseURL from options), zero models.
    assert.equal(captured.providers.length, 1);
    assert.deepEqual(captured.providers[0].models, []);
    assert.equal(captured.tools.length, 1);
    (cleanup as () => void)();
  } finally {
    if (prevKey !== undefined) process.env.OMNIROUTE_API_KEY = prevKey;
    if (prevBase !== undefined) process.env.OMNIROUTE_BASE_URL = prevBase;
  }
});
