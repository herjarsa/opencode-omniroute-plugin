#!/usr/bin/env bun
/**
 * OmniRoute debug MCP server — exposes request/response logs captured by
 * the plugin's `features.debugLog` fetch wrapper.
 *
 * Runs as a stdio MCP server. Register in opencode.jsonc:
 *
 *   "omniroute-debug": {
 *     "type": "local",
 *     "command": ["bun", "/path/to/scripts/debug-mcp.ts", "--providerId", "omniroute"],
 *     "enabled": true
 *   }
 *
 * Or with bunx (after npm publish):
 *   "command": ["bunx", "@mr.mm/opencode-omniroute-plugin/scripts/debug-mcp.ts", "--providerId", "omniroute"]
 *
 * Tools exposed:
 *   omniroute_debug_status   — is logging on, entry count, log file path
 *   omniroute_debug_enable   — enable logging for this providerId
 *   omniroute_debug_disable  — disable logging
 *   omniroute_debug_latest   — last N log entries (default 5)
 *   omniroute_debug_get      — get single entry by reqId
 *   omniroute_debug_clear    — wipe the log file
 */

import { homedir } from "os";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "fs";
import { join } from "path";

interface DebugLogEntry {
  reqId: string;
  providerId: string;
  ts: number;
  url: string;
  method: string;
  reqHeaders: Record<string, string>;
  reqBody: unknown;
  resStatus: number | null;
  resHeaders: Record<string, string>;
  resBody: unknown;
  durationMs: number | null;
  error?: string;
}

function debugLogDir(): string {
  const dir = join(homedir(), ".local", "share", "opencode", "plugins");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}
function debugLogPath(pid: string) {
  return join(debugLogDir(), `omniroute-debug-${pid}.jsonl`);
}
function debugStatePath(pid: string) {
  return join(debugLogDir(), `omniroute-debug-${pid}.state.json`);
}

function debugLogEnabled(pid: string): boolean {
  try {
    return (
      (
        JSON.parse(readFileSync(debugStatePath(pid), "utf8")) as {
          enabled?: boolean;
        }
      ).enabled === true
    );
  } catch {
    return false;
  }
}
function debugLogSetEnabled(pid: string, enabled: boolean) {
  writeFileSync(debugStatePath(pid), JSON.stringify({ enabled }), "utf8");
}
function debugLogRead(pid: string, limit = 20): DebugLogEntry[] {
  const p = debugLogPath(pid);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .slice(-limit)
    .map((l) => {
      try {
        return JSON.parse(l) as DebugLogEntry;
      } catch {
        return null;
      }
    })
    .filter((e): e is DebugLogEntry => e !== null);
}
function debugLogGetById(pid: string, reqId: string): DebugLogEntry | null {
  const p = debugLogPath(pid);
  if (!existsSync(p)) return null;
  const lines = readFileSync(p, "utf8").trim().split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]) as DebugLogEntry;
      if (e.reqId === reqId) return e;
    } catch {
      /**/
    }
  }
  return null;
}
function debugLogClear(pid: string) {
  const p = debugLogPath(pid);
  if (existsSync(p)) writeFileSync(p, "", "utf8");
}

// ── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const providerIdx = args.indexOf("--providerId");
const providerId = providerIdx !== -1 ? args[providerIdx + 1] : "omniroute";

// ── MCP stdio transport (JSON-RPC 2.0) ─────────────────────────────────────
const tools = [
  {
    name: "omniroute_debug_status",
    description:
      "Check whether OmniRoute debug logging is enabled and how many entries are in the log.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "omniroute_debug_enable",
    description:
      "Enable OmniRoute request/response debug logging for the current session.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "omniroute_debug_disable",
    description: "Disable OmniRoute request/response debug logging.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "omniroute_debug_latest",
    description: "Return the latest N OmniRoute request/response log entries.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Number of entries to return (default: 5, max: 50)",
        },
      },
      required: [],
    },
  },
  {
    name: "omniroute_debug_get",
    description:
      "Get a specific OmniRoute request/response log entry by reqId.",
    inputSchema: {
      type: "object",
      properties: {
        reqId: {
          type: "string",
          description: "Request ID (UUID) from a log entry",
        },
      },
      required: ["reqId"],
    },
  },
  {
    name: "omniroute_debug_clear",
    description: "Clear all OmniRoute debug log entries for this provider.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
];

function logFilePath(): string {
  return join(
    homedir(),
    ".local",
    "share",
    "opencode",
    "plugins",
    `omniroute-debug-${providerId}.jsonl`,
  );
}

function entryCount(): number {
  const p = logFilePath();
  if (!existsSync(p)) return 0;
  try {
    return statSync(p).size === 0
      ? 0
      : require("fs").readFileSync(p, "utf8").trim().split("\n").filter(Boolean)
          .length;
  } catch {
    return 0;
  }
}

function handleTool(name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case "omniroute_debug_status":
      return {
        providerId,
        enabled: debugLogEnabled(providerId),
        entries: entryCount(),
        logFile: logFilePath(),
      };

    case "omniroute_debug_enable":
      debugLogSetEnabled(providerId, true);
      return {
        ok: true,
        message: `Debug logging enabled for providerId="${providerId}". Requests will be logged to ${logFilePath()}`,
      };

    case "omniroute_debug_disable":
      debugLogSetEnabled(providerId, false);
      return {
        ok: true,
        message: `Debug logging disabled for providerId="${providerId}"`,
      };

    case "omniroute_debug_latest": {
      const limit = Math.min(Number(args.limit ?? 5), 50);
      const entries = debugLogRead(providerId, limit);
      return {
        count: entries.length,
        entries: entries.map((e) => ({
          reqId: e.reqId,
          ts: new Date(e.ts).toISOString(),
          method: e.method,
          url: e.url,
          resStatus: e.resStatus,
          durationMs: e.durationMs,
          error: e.error,
        })),
        hint: "Use omniroute_debug_get with a reqId to see full request/response body",
      };
    }

    case "omniroute_debug_get": {
      const reqId = String(args.reqId ?? "");
      if (!reqId) return { error: "reqId is required" };
      const entry = debugLogGetById(providerId, reqId);
      if (!entry) return { error: `No entry found with reqId="${reqId}"` };
      return {
        ...entry,
        ts: new Date(entry.ts).toISOString(),
      };
    }

    case "omniroute_debug_clear":
      debugLogClear(providerId);
      return {
        ok: true,
        message: `Cleared debug log for providerId="${providerId}"`,
      };

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ── Stdio JSON-RPC 2.0 loop ──────────────────────────────────────────────────
process.stdin.setEncoding("utf8");
let buf = "";

process.stdin.on("data", (chunk: string) => {
  buf += chunk;
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const msg = JSON.parse(trimmed) as {
        jsonrpc: string;
        id?: unknown;
        method?: string;
        params?: unknown;
      };

      if (msg.method === "initialize") {
        respond(msg.id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "omniroute-debug", version: "0.1.0" },
        });
        continue;
      }

      if (msg.method === "tools/list") {
        respond(msg.id, { tools });
        continue;
      }

      if (msg.method === "tools/call") {
        const p = msg.params as {
          name?: string;
          arguments?: Record<string, unknown>;
        };
        const result = handleTool(p.name ?? "", p.arguments ?? {});
        respond(msg.id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        });
        continue;
      }

      if (msg.method === "notifications/initialized") continue;

      respond(msg.id, null, {
        code: -32601,
        message: `Method not found: ${msg.method}`,
      });
    } catch (e) {
      process.stderr.write(`[omniroute-debug-mcp] parse error: ${e}\n`);
    }
  }
});

function respond(
  id: unknown,
  result: unknown,
  error?: { code: number; message: string },
) {
  const msg = error
    ? { jsonrpc: "2.0", id, error }
    : { jsonrpc: "2.0", id, result };
  process.stdout.write(JSON.stringify(msg) + "\n");
}

process.stderr.write(
  `[omniroute-debug-mcp] started for providerId="${providerId}"\n`,
);
