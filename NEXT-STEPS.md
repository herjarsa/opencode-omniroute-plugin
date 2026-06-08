# Next Steps: TUI Restart + Verification

## Current State

- ✅ `ensureV1Suffix` fix committed (f69e217) — auth hook + resolveApiBlock now return `/v1` URLs
- ✅ 5 MCP servers disabled — tool count expected to drop from 203 → ~75
- ⚠️ TUI server still running old plugin code — all debug log entries show `/chat/completions` (no `/v1`)
- ⚠️ Last request in debug log: 14:22:37 (20+ min ago, got 524 timeout)

## What Needs to Happen

### 1. Restart OpenCode TUI

The plugin is loaded at startup. Changes won't take effect until you restart:

```bash
# Exit current TUI session (Ctrl+C or /exit)
# Then restart
opencode
```

### 2. Verify Plugin Loaded New Code

After restart, send a test message and check the debug log:

```bash
# Check debug log for new requests with /v1 in URL
cat ~/.local/share/opencode/plugins/omniroute-debug-omniroute.jsonl | tail -5
```

**Expected:** URLs should show `https://or4269.mrmm.xyz/v1/chat/completions` (with `/v1`)

### 3. Verify Tool Count Reduction

Send a message in OpenCode, then capture the request:

```bash
# Get latest debug entry
# In OpenCode: send any message, then check debug log
# Look for tools array length in reqBody
```

**Expected:** Tool count ≤80 (down from 203)

### 4. Run Comparison Test

With ANTHROPIC_API_KEY set, run the headless test:

```bash
cd /Users/mourad.maatoug/code/public/github.com/mrmm/opencode-omniroute-plugin
export ANTHROPIC_API_KEY=sk-ant-...
./test-comparison.sh "What tools do you have available?"
```

This compares:

- OmniRoute response (via OpenAI-compat format)
- Direct Anthropic response (via native format)
- Latency, tool format, usage metrics

### 5. Verify Feature Parity

Check that the response includes:

- [ ] Tool calls work correctly
- [ ] No "I don't have tools" confusion
- [ ] Thinking/reasoning content present (if on thinking model)
- [ ] Usage tokens reported correctly
- [ ] No 5xx errors or timeouts

## Commands to Run

```bash
# 1. Exit TUI
# Ctrl+C or /exit

# 2. Restart
opencode

# 3. In OpenCode, send a test message
# "What tools do you have available? List them briefly."

# 4. Check debug log
cat ~/.local/share/opencode/plugins/omniroute-debug-omniroute.jsonl | tail -1 | python3 -c "
import json, sys
entry = json.loads(sys.stdin.readline())
print('URL:', entry.get('url'))
print('Status:', entry.get('resStatus'))
print('Duration:', entry.get('durationMs'), 'ms')
if 'reqBody' in entry:
    body = entry['reqBody']
    print('Tools count:', len(body.get('tools', [])))
    print('Model:', body.get('model'))
"

# 5. Run comparison (optional, needs ANTHROPIC_API_KEY)
cd /Users/mourad.maatoug/code/public/github.com/mrmm/opencode-omniroute-plugin
./test-comparison.sh
```

## Success Criteria

| Metric             | Before              | After                  | Status    |
| ------------------ | ------------------- | ---------------------- | --------- |
| URL path           | `/chat/completions` | `/v1/chat/completions` | ⏳ Verify |
| Tool count         | 203                 | ≤80                    | ⏳ Verify |
| System prompt size | 75K chars           | ≤50K                   | ⏳ Verify |
| Request body size  | 600KB               | ≤200KB                 | ⏳ Verify |
| Response quality   | Confused by tools   | Works correctly        | ⏳ Verify |
| Latency            | 28s+                | <10s                   | ⏳ Verify |

## Troubleshooting

### If URL still shows `/chat/completions`:

- Plugin didn't rebuild: run `npm run build` in plugin repo
- Plugin not loaded: check `opencode.jsonc` plugin path
- Old dist cached: delete `dist/` and rebuild

### If tool count still high:

- MCP servers didn't disable: check `opencode.jsonc` `mcp` section
- Other MCP servers active: list all with `cat opencode.jsonc | grep -A2 '"enabled"'`

### If 524 timeout:

- OmniRoute overwhelmed: check `omniroute_get_health`
- Too many tools: reduce further by disabling more MCP servers
- Network issue: check `curl https://or4269.mrmm.xyz/health`
