/**
 * OpenCode V2 (Desktop) compatibility layer for the OmniRoute plugin.
 *
 * OpenCode V2 ships a new plugin API (`@opencode/plugin`:
 * `Plugin.define({ id, setup(ctx) })`). V1 implementations
 * (`{ id, server() }` from `@opencode-ai/plugin`) do NOT run on V2 —
 * the loader drops them with a SchemaError. This module implements the
 * V2 `setup(ctx)` entrypoint while reusing 100% of the V1 catalog
 * pipeline (fetchers, TTL cache, enrichment, LCD combo roll-up,
 * usableOnly/enabledOnly/activeOnly filters) by driving the existing
 * `createOmniRouteProviderHook().models()` with a synthetic auth context
 * and converting each V1 `ModelV2` into a V2 `Model.Info`.
 *
 * Runtime-dependency-free by design: everything here uses `import type`
 * for V2 shapes (erased at build) and plain objects at runtime, so the
 * bundled `dist/index.js` gains NO new runtime dependency and the V1
 * path (`server()`) never touches this file.
 *
 * Dual export (see `src/index.ts` bottom):
 *   `export default { id, setup: setupOmniRouteV2, server: OmniRoutePlugin }`
 * V1 hosts (≥1.18.29) call `server()`; V2 hosts call `setup()`.
 */

import type { Model as ModelV2 } from "@opencode-ai/sdk/v2";
import {
  createOmniRouteProviderHook,
  ensureV1Suffix,
  forceSyncOmniRouteModels,
  parseOmniRoutePluginOptions,
  resolveOmniRoutePluginOptions,
  sanitizeGeminiToolSchemas,
  type OmniRouteFetchCache,
  type ResolvedOmniRoutePluginOptions,
} from "./index.js";

/** Stable V2 plugin id (same module identifier as the V1 `{ id, server }` shape). */
export const OMNIROUTE_V2_PLUGIN_ID = "@omniroute/opencode-plugin" as const;

/** AI provider package used for the dynamically registered OmniRoute provider. */
export const OMNIROUTE_V2_PROVIDER_PACKAGE = "@opencode/ai/providers/openai-compatible" as const;

/**
 * Minimal structural V2 `Model.Info` — only the fields the catalog
 * registry requires. Mirrors `@opencode/schema` `Model.Info` required
 * members (`id`, `modelID`, `providerID`, `name`, `capabilities`,
 * `variants`, `time`, `cost`, `status`, `enabled`, `limit`).
 */
export interface OmniRouteV2ModelInfo {
  id: string;
  modelID: string;
  providerID: string;
  name: string;
  capabilities: { tools: boolean; input: string[]; output: string[] };
  cost: Array<{
    input: number;
    output: number;
    cache: { read: number; write: number };
  }>;
  limit: { context: number; input?: number; output: number };
  status: "alpha" | "beta" | "deprecated" | "active";
  enabled: boolean;
  time: { released: number };
  variants: never[];
}

/**
 * Derive the V2 model id from a V1 catalog key.
 *
 * V1 keys are heterogeneous: raw models whose upstream id already
 * contains a slash keep it verbatim (`cc/claude-opus-4-7`), while bare
 * ids and combos are prefixed with the owning provider
 * (`omniroute/MASTER`). V2 carries the provider separately
 * (`providerID` + full `providerID/modelID` ref parsed on the FIRST
 * slash), so the owning-provider prefix must be stripped while the
 * upstream namespace is preserved:
 *
 *   - `omniroute/MASTER`            → `MASTER`
 *   - `omniroute/bare-model`        → `bare-model`
 *   - `cc/claude-opus-4-7`          → `cc/claude-opus-4-7` (untouched)
 *   - `auto/coding`                 → `auto/coding` (untouched)
 */
export function modelV2KeyToV2ModelId(key: string, omnirouteProviderId: string): string {
  const prefix = `${omnirouteProviderId}/`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

/**
 * Convert a V1 `ModelV2` catalog entry into a V2 `Model.Info`.
 *
 * Mapping notes (V2 simplifies capabilities to `{ tools, input[],
 * output[] }` — reasoning/attachment/temperature/interleaved have no V2
 * slot and are intentionally dropped; routing semantics live on the
 * OmniRoute server):
 *
 *   - `id`/`modelID` via `modelV2KeyToV2ModelId` (see above).
 *   - `capabilities.tools` ← `ModelV2.capabilities.toolcall`.
 *   - `capabilities.input/output` ← modality flags set to true
 *     (default `["text"]` when empty, mirroring the V1 fetcher default).
 *   - `cost` ← single-tier array from the V1 zeroed/enriched cost block.
 *   - `limit` ← truncated non-negative ints (`input` only when present).
 *   - `time.released` ← `Date.parse(release_date)` or `0`.
 *   - `status: "active"`, `enabled: true`, `variants: []`.
 */
export function convertModelV2ToInfo(
  model: ModelV2,
  v2ProviderId: string,
  omnirouteProviderId: string,
): OmniRouteV2ModelInfo {
  const id = modelV2KeyToV2ModelId(model.id, omnirouteProviderId);
  const rawIn = (model.capabilities?.input ?? {}) as Record<string, unknown>;
  const rawOut = (model.capabilities?.output ?? {}) as Record<string, unknown>;
  const input: string[] = [];
  const output: string[] = [];
  for (const k of ["text", "audio", "image", "video", "pdf"]) {
    if (rawIn[k] === true) input.push(k);
    if (rawOut[k] === true) output.push(k);
  }
  if (input.length === 0) input.push("text");
  if (output.length === 0) output.push("text");
  const cost = model.cost ?? { input: 0, output: 0, cache: { read: 0, write: 0 } };
  const limit = model.limit ?? { context: 0, output: 0 };
  let released = 0;
  const rd: unknown = (model as unknown as Record<string, unknown>).release_date;
  if (typeof rd === "string" && rd.length > 0) {
    const t = Date.parse(rd);
    if (Number.isFinite(t) && t > 0) released = Math.trunc(t);
  }
  const entry: OmniRouteV2ModelInfo = {
    id,
    modelID: id,
    providerID: v2ProviderId,
    name: typeof model.name === "string" && model.name.length > 0 ? model.name : id,
    capabilities: {
      tools: Boolean(model.capabilities?.toolcall),
      input,
      output,
    },
    cost: [
      {
        input: typeof cost.input === "number" ? cost.input : 0,
        output: typeof cost.output === "number" ? cost.output : 0,
        cache: {
          read: typeof cost.cache?.read === "number" ? cost.cache.read : 0,
          write: typeof cost.cache?.write === "number" ? cost.cache.write : 0,
        },
      },
    ],
    limit: {
      context: Math.max(0, Math.trunc(limit.context ?? 0)),
      ...(typeof (limit as { input?: unknown }).input === "number"
        ? { input: Math.max(0, Math.trunc((limit as { input: number }).input)) }
        : {}),
      output: Math.max(0, Math.trunc(limit.output ?? 0)),
    },
    status: "active",
    enabled: true,
    time: { released },
    variants: [],
  };
  return entry;
}

/**
 * Best-effort API-key extraction from a V2 integration credential.
 * Tolerates the key/text/token/value shapes across host versions plus
 * one level of nesting (`data`/`credential`/`connection` wrappers).
 */
export function extractV2ApiKey(credential: unknown): string {
  if (!credential || typeof credential !== "object") return "";
  const c = credential as Record<string, unknown>;
  for (const k of ["key", "apiKey", "token", "value", "secret"]) {
    const v = c[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  for (const k of ["data", "credential", "connection"]) {
    const nested = c[k];
    if (nested && typeof nested === "object") {
      const found = extractV2ApiKey(nested);
      if (found) return found;
    }
  }
  return "";
}

/** Read a string env var without crashing when `process` is unavailable. */
function readEnv(name: string): string {
  try {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } })
      .process?.env;
    const v = env?.[name];
    return typeof v === "string" ? v : "";
  } catch {
    return "";
  }
}

/**
 * Resolve the inference API key for a V2 setup: active integration
 * connection first (the V2 `/connect` equivalent), then
 * `OMNIROUTE_API_KEY` env. Empty string means "not connected yet" —
 * the provider still registers (with baseURL) so the connect flow can
 * complete, and the credential subscription picks the catalog up.
 */
export async function resolveV2ApiKey(ctx: unknown, providerId: string): Promise<string> {
  try {
    const integration = (ctx as Record<string, unknown> | null | undefined)?.[
      "integration"
    ] as
      | {
          connection?: {
            active?: (id: string) => Promise<unknown>;
            resolve?: (conn: unknown) => Promise<unknown>;
          };
        }
      | undefined;
    const active = integration?.connection?.active;
    const resolveFn = integration?.connection?.resolve;
    if (typeof active === "function" && typeof resolveFn === "function") {
      try {
        const conn = await active(providerId);
        if (conn) {
          try {
            const cred = await resolveFn(conn);
            const k = extractV2ApiKey(cred);
            if (k) return k;
          } catch {
            /* fall through to env */
          }
        }
      } catch {
        /* no active connection — fall through to env */
      }
    }
  } catch {
    /* host without integration domain — fall through to env */
  }
  const envKey = readEnv("OMNIROUTE_API_KEY") || readEnv("OMNIROUTE_KEY");
  return envKey;
}

/** Resolve the gateway baseURL for a V2 setup: options first, then env. */
export function resolveV2BaseURL(resolved: ResolvedOmniRoutePluginOptions): string {
  if (typeof resolved.baseURL === "string" && resolved.baseURL.length > 0) {
    return resolved.baseURL;
  }
  return readEnv("OMNIROUTE_BASE_URL") || readEnv("OMNIROUTE_URL");
}

function buildV2ProviderInfo(args: {
  providerId: string;
  displayName: string;
  baseURL: string;
  apiKey: string;
}): Record<string, unknown> {
  const settings: Record<string, unknown> = { baseURL: ensureV1Suffix(args.baseURL) };
  if (args.apiKey) settings.apiKey = args.apiKey;
  return {
    id: args.providerId,
    name: args.displayName,
    activation: "enabled",
    package: OMNIROUTE_V2_PROVIDER_PACKAGE,
    settings,
    integrationID: args.providerId,
  };
}

function warn(...parts: unknown[]): void {
  try {
    console.warn("[omniroute-plugin][v2]", ...parts);
  } catch {
    /* logging must never break setup */
  }
}

/**
 * V2 `setup(ctx)` implementation. Registered as `setup` on the dual
 * default export; V2 hosts call it, V1 hosts ignore it.
 *
 * The `ctx` parameter is intentionally typed as `unknown` (narrowed
 * internally with optional chaining + try/catch per domain) so this
 * module needs no runtime import of `@opencode/plugin` and keeps
 * working across host minor versions that add/remove domains.
 *
 * Returns a cleanup function (clears the refresh timer + aborts the
 * credential subscription) per the V2 lifecycle contract.
 */
export async function setupOmniRouteV2(ctx: unknown): Promise<(() => void) | void> {
  const c = ctx as Record<string, (...args: never[]) => unknown> & {
    options?: unknown;
    provider?: {
      transform?: (cb: (editor: unknown) => void) => Promise<unknown>;
      reload?: () => Promise<unknown>;
    };
    model?: { reload?: () => Promise<unknown> };
    integration?: {
      transform?: (cb: (editor: unknown) => void) => Promise<unknown>;
    };
    tool?: { transform?: (cb: (editor: unknown) => void) => Promise<unknown> };
    command?: { transform?: (cb: (editor: unknown) => void) => Promise<unknown> };
    mcp?: { transform?: (cb: (editor: unknown) => void) => Promise<unknown> };
    session?: {
      hook?: (name: string, cb: (event: unknown) => void, opts?: unknown) => Promise<unknown>;
      prompt?: (input: unknown) => Promise<unknown>;
      synthetic?: (input: unknown) => Promise<unknown>;
    };
    event?: { subscribe?: (opts?: unknown) => AsyncIterable<unknown> };
  };
  let parsed;
  try {
    parsed = parseOmniRoutePluginOptions(c?.options);
  } catch (err) {
    warn("invalid options, falling back to defaults:", err);
    parsed = {};
  }
  const resolved = resolveOmniRoutePluginOptions(parsed);
  // V2 has no native-adapter providerID gate ({openai, anthropic,
  // opencode*} was a V1 1.17.8+ constraint), so the BARE OmniRoute id
  // ("omniroute", "omniroute-preprod") is the V2 provider identity.
  const providerId = resolved.omnirouteProviderId;
  const displayName =
    resolved.displayName === `OmniRoute (${resolved.providerId})`
      ? `OmniRoute (${providerId})`
      : resolved.displayName;

  const sharedCache: OmniRouteFetchCache = new Map();
  const source: {
    info: Record<string, unknown> | null;
    models: OmniRouteV2ModelInfo[];
    baseURL: string;
  } = { info: null, models: [], baseURL: "" };

  const loadCatalog = async (): Promise<void> => {
    try {
      const baseURL = resolveV2BaseURL(resolved);
      if (!baseURL) {
        source.info = null;
        source.models = [];
        source.baseURL = "";
        warn(
          `no baseURL for provider ${providerId} — set plugin option baseURL or OMNIROUTE_BASE_URL env`,
        );
        return;
      }
      source.baseURL = baseURL;
      const apiKey = await resolveV2ApiKey(ctx, providerId);
      if (!apiKey) {
        // Register the provider shell (baseURL, no models) so the
        // integration connect flow has a target; the credential
        // subscription below reloads the catalog once connected.
        source.info = buildV2ProviderInfo({ providerId, displayName, baseURL, apiKey: "" });
        source.models = [];
        return;
      }
      const hook = createOmniRouteProviderHook(parsed, { cache: sharedCache });
      if (typeof hook.models !== "function") {
        warn("provider hook has no models() — skipping catalog load");
        return;
      }
      const catalog = (await hook.models(
        { options: { baseURL } } as never,
        { auth: { type: "api", key: apiKey, baseURL } } as never,
      )) as Record<string, ModelV2> | undefined;
      const entries = Object.values(catalog ?? {});
      source.models = entries.map((m) => convertModelV2ToInfo(m, providerId, providerId));
      source.info = buildV2ProviderInfo({ providerId, displayName, baseURL, apiKey });
      warn(`catalog loaded provider=${providerId} models=${source.models.length}`);
    } catch (err) {
      // Never let a fetch failure break setup — keep the previous
      // source so the last-known-good catalog survives.
      warn(`catalog load failed provider=${providerId}:`, err);
    }
  };

  await loadCatalog();

  // ── Provider + models (replayable transform; reload() replays it) ──
  try {
    await c?.provider?.transform?.((editor) => {
      const ed = editor as {
        add?: (input: { info: unknown; models: unknown[] }) => void;
      };
      if (source.info && typeof ed.add === "function") {
        ed.add({ info: source.info, models: source.models });
      }
    });
  } catch (err) {
    warn("provider.transform failed:", err);
  }

  // ── Integration auth method (V2 `/connect` surface) ──
  try {
    await c?.integration?.transform?.((editor) => {
      const ed = editor as {
        method?: {
          update?: (input: unknown) => void;
        };
      };
      try {
        ed.method?.update?.({
          integrationID: providerId,
          method: { type: "key", label: `${displayName} API Key` },
        });
      } catch {
        /* host without key-method support */
      }
    });
  } catch (err) {
    warn("integration.transform failed:", err);
  }

  // ── Force-sync tool (Pi `/omni sync` equivalent) ──
  try {
    await c?.tool?.transform?.((editor) => {
      const ed = editor as {
        add?: (tool: Record<string, unknown>) => void;
      };
      ed.add?.({
        name: "omniroute_sync_models",
        description:
          "Force-refresh the OmniRoute model catalog (OpenCode equivalent of Pi `/omni sync`). " +
          "Invalidates in-memory and disk caches, then re-fetches GET /v1/models (and combos when enabled).",
        input: {
          type: "object",
          properties: {
            reason: { type: "string", description: "Optional reason for the sync (logging only)" },
          },
          required: [],
          additionalProperties: false,
        },
        execute: async (input: unknown) => {
          const result = await forceSyncOmniRouteModels({ resolved, cache: sharedCache });
          try {
            await loadCatalog();
          } catch {
            /* catalog refresh is best-effort */
          }
          try {
            await c?.provider?.reload?.();
          } catch {
            /* older hosts */
          }
          try {
            await c?.model?.reload?.();
          } catch {
            /* older hosts */
          }
          const reason =
            (input as { reason?: unknown } | null)?.reason &&
            typeof (input as { reason: unknown }).reason === "string"
              ? ` reason=${(input as { reason: string }).reason}`
              : "";
          const text = result.ok
            ? `OmniRoute models synced.\nprovider: ${result.provider}\nbaseURL: ${result.baseURL}\nmodels: ${result.count}\ncombos: ${result.combos}\npreservedLastKnownGood: ${result.preserved ?? false}\nclearedMemoryEntries: ${result.clearedMemory}\nclearedDiskSnapshot: ${result.clearedDisk}\nTTL: ${resolved.modelCacheTtl}ms${reason}`
            : `OmniRoute model sync failed for provider=${result.provider}.${reason}\n${result.error ?? "unknown error"}`;
          return { content: text, metadata: { ...(result as Record<string, unknown>) } };
        },
      });
    });
  } catch (err) {
    warn("tool.transform failed:", err);
  }

  // ── Commands: /omni-sync + /omni-autosync ──
  try {
    await c?.command?.transform?.((editor) => {
      const ed = editor as {
        add?: (cmd: Record<string, unknown>) => void;
      };
      ed.add?.({
        name: "omni-sync",
        description: "Force-refresh OmniRoute model catalog (like Pi /omni sync)",
        execute: async (invocation: unknown) => {
          const sessionID = (invocation as { sessionID?: unknown } | null)?.sessionID;
          const result = await forceSyncOmniRouteModels({ resolved, cache: sharedCache });
          try {
            await loadCatalog();
          } catch {
            /* best-effort */
          }
          try {
            await c?.provider?.reload?.();
          } catch {
            /* older hosts */
          }
          const text = result.ok
            ? `OmniRoute sync ok: ${result.count} models, ${result.combos} combos (provider ${result.provider}).`
            : `OmniRoute sync failed for provider ${result.provider}: ${result.error ?? "unknown error"}`;
          try {
            if (sessionID !== undefined) await c?.session?.synthetic?.({ sessionID, text });
          } catch {
            try {
              if (sessionID !== undefined) await c?.session?.prompt?.({ sessionID, text });
            } catch {
              /* reporting is best-effort */
            }
          }
        },
      });
      ed.add?.({
        name: "omni-autosync",
        description: "Show OmniRoute startup-sync / cache status",
        execute: async (invocation: unknown) => {
          const sessionID = (invocation as { sessionID?: unknown } | null)?.sessionID;
          const text =
            `Report OmniRoute discovery status for provider ${providerId}: ` +
            `modelCacheTtl=${resolved.modelCacheTtl}. The plugin loads the catalog at setup, ` +
            `refreshes on TTL expiry, and reloads on credential changes. ` +
            `Run /omni-sync or call omniroute_sync_models to refresh now.`;
          try {
            if (sessionID !== undefined) await c?.session?.synthetic?.({ sessionID, text });
          } catch {
            /* reporting is best-effort */
          }
        },
      });
    });
  } catch (err) {
    warn("command.transform failed:", err);
  }

  // ── MCP auto-emit (parity with the V1 config hook) ──
  try {
    if (resolved.features?.mcpAutoEmit === true && source.baseURL) {
      const root = source.baseURL.replace(/\/v\d+\/?$/, "").replace(/\/$/, "");
      const url = `${root}/api/mcp/stream`;
      const apiKey = await resolveV2ApiKey(ctx, providerId);
      const token = resolved.features?.mcpToken ?? apiKey;
      await c?.mcp?.transform?.((editor) => {
        const ed = editor as {
          get?: (name: string) => unknown;
          set?: (name: string, config: unknown) => void;
        };
        try {
          if (typeof ed.get === "function" && ed.get(providerId)) return; // operator override wins
        } catch {
          /* read-through not supported — continue to set */
        }
        ed.set?.(providerId, {
          type: "remote",
          url,
          enabled: true,
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
      });
    }
  } catch (err) {
    warn("mcp.transform failed:", err);
  }

  // ── Gemini tool-schema sanitization at the semantic layer ──
  // V1 injected this at the fetch layer; V2 exposes the assembled tool
  // set on the session context hook, which is narrower (no stream
  // handling) and applies before protocol lowering.
  const sanitizeHook = (event: unknown): void => {
    try {
      const ev = event as {
        model?: { id?: unknown };
        tools?: Record<string, { input?: unknown }>;
      } | null;
      const modelId = ev?.model?.id;
      if (typeof modelId !== "string" || !/gemini/i.test(modelId)) return;
      const tools = ev?.tools;
      if (!tools || typeof tools !== "object") return;
      for (const tool of Object.values(tools)) {
        try {
          const input = (tool as { input?: unknown } | null)?.input;
          if (input && typeof input === "object") {
            (tool as { input: unknown }).input = sanitizeGeminiToolSchemas(input);
          }
        } catch {
          /* per-tool soft-fail */
        }
      }
    } catch {
      /* hook must never throw */
    }
  };
  if ((resolved.features ?? {}).geminiSanitization !== false) {
    for (const name of ["context", "compaction", "generate"] as const) {
      try {
        await c?.session?.hook?.(name, sanitizeHook, { providerID: providerId });
      } catch (err) {
        warn(`session.hook(${name}) failed:`, err);
      }
    }
  }

  // ── TTL refresh (mirrors `modelCacheTtl`; cleanup clears it) ──
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    const intervalMs = Math.max(60_000, resolved.modelCacheTtl);
    timer = setInterval(() => {
      void (async () => {
        await loadCatalog();
        try {
          await c?.provider?.reload?.();
        } catch {
          /* host without reload */
        }
      })();
    }, intervalMs);
    (timer as unknown as { unref?: () => void }).unref?.();
  } catch {
    /* timer unavailable — catalog stays at setup-time snapshot */
  }

  // ── Credential-change subscription: instant pickup after connect ──
  const controller = new AbortController();
  try {
    const subscribe = c?.event?.subscribe;
    if (typeof subscribe === "function") {
      void (async () => {
        try {
          const stream = subscribe.call(c, { signal: controller.signal }) as AsyncIterable<unknown>;
          for await (const event of stream) {
            try {
              const t = (event as { type?: unknown } | null)?.type;
              if (typeof t === "string" && t.includes("credential")) {
                await loadCatalog();
                try {
                  await c?.provider?.reload?.();
                } catch {
                  /* host without reload */
                }
              }
            } catch {
              /* per-event soft-fail */
            }
          }
        } catch {
          /* aborted or host without event stream */
        }
      })();
    }
  } catch {
    /* host without event domain */
  }

  return () => {
    try {
      if (timer !== undefined) clearInterval(timer);
    } catch {
      /* already cleared */
    }
    try {
      controller.abort();
    } catch {
      /* already aborted */
    }
  };
}
