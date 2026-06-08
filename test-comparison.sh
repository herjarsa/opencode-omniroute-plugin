#!/bin/bash
# Headless test: Compare OmniRoute vs Direct Anthropic API
# Usage: ./test-comparison.sh [prompt]

set -euo pipefail

PROMPT="${1:-What tools do you have available? List them briefly.}"
OMNIRoute_BASE="https://or4269.mrmm.xyz"
ANTHROPIC_BASE="https://api.anthropic.com/v1"
MODEL="claude-sonnet-4-20250514"

# Read API keys from config
OMNIRoute_KEY=$(cat ~/.local/share/opencode/auth.json | grep -o '"apiKey":"[^"]*"' | head -1 | cut -d'"' -f4)
ANTHROPIC_KEY="${ANTHROPIC_API_KEY:-}"

if [ -z "$OMNIRoute_KEY" ]; then
  echo "ERROR: No OmniRoute API key found in ~/.local/share/opencode/auth.json"
  exit 1
fi

if [ -z "$ANTHROPIC_KEY" ]; then
  echo "ERROR: Set ANTHROPIC_API_KEY environment variable for direct comparison"
  echo "  export ANTHROPIC_API_KEY=sk-ant-..."
  exit 1
fi

echo "=== Test Configuration ==="
echo "Prompt: $PROMPT"
echo "Model: $MODEL"
echo ""

# Minimal tool set for comparison
TOOLS='[
  {
    "type": "function",
    "function": {
      "name": "read_file",
      "description": "Read a file from the filesystem",
      "parameters": {
        "type": "object",
        "properties": {
          "path": {"type": "string", "description": "File path to read"}
        },
        "required": ["path"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "write_file",
      "description": "Write content to a file",
      "parameters": {
        "type": "object",
        "properties": {
          "path": {"type": "string", "description": "File path to write"},
          "content": {"type": "string", "description": "Content to write"}
        },
        "required": ["path", "content"]
      }
    }
  }
]'

MESSAGES='[{"role": "user", "content": "'"$PROMPT"'"}]'

echo "=== Path A: OmniRoute (OpenAI-compat format) ==="
echo "URL: $OMNIRoute_BASE/v1/chat/completions"
echo ""

OMNIRoute_START=$(date +%s%N)
OMNIRoute_RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST "$OMNIRoute_BASE/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OMNIRoute_KEY" \
  -d "{
    \"model\": \"$MODEL\",
    \"messages\": $MESSAGES,
    \"tools\": $TOOLS,
    \"max_tokens\": 1024
  }" 2>&1)
OMNIRoute_END=$(date +%s%N)
OMNIRoute_MS=$(( (OMNIRoute_END - OMNIRoute_START) / 1000000 ))

OMNIRoute_HTTP=$(echo "$OMNIRoute_RESPONSE" | tail -1)
OMNIRoute_BODY=$(echo "$OMNIRoute_RESPONSE" | sed '$d')

echo "HTTP Status: $OMNIRoute_HTTP"
echo "Latency: ${OMNIRoute_MS}ms"
echo "Response size: $(echo "$OMNIRoute_BODY" | wc -c) bytes"
echo ""

# Parse response
if [ "$OMNIRoute_HTTP" = "200" ]; then
  echo "Content:"
  echo "$OMNIRoute_BODY" | python3 -c "
import json, sys
data = json.load(sys.stdin)
msg = data.get('choices', [{}])[0].get('message', {})
print(msg.get('content', 'No content')[:500])
print()
print('Tool calls:', len(msg.get('tool_calls', [])))
print('Finish reason:', data.get('choices', [{}])[0].get('finish_reason'))
print('Usage:', data.get('usage', {}))
" 2>/dev/null || echo "$OMNIRoute_BODY" | head -20
else
  echo "Error response:"
  echo "$OMNIRoute_BODY" | head -20
fi

echo ""
echo "=== Path B: Direct Anthropic (native format) ==="
echo "URL: $ANTHROPIC_BASE/messages"
echo ""

# Convert tools to Anthropic format
ANTHROPIC_TOOLS='[
  {
    "name": "read_file",
    "description": "Read a file from the filesystem",
    "input_schema": {
      "type": "object",
      "properties": {
        "path": {"type": "string", "description": "File path to read"}
      },
      "required": ["path"]
    }
  },
  {
    "name": "write_file",
    "description": "Write content to a file",
    "input_schema": {
      "type": "object",
      "properties": {
        "path": {"type": "string", "description": "File path to write"},
        "content": {"type": "string", "description": "Content to write"}
      },
      "required": ["path", "content"]
    }
  }
]'

ANTHROPIC_MESSAGES='[{"role": "user", "content": "'"$PROMPT"'"}]'

DIRECT_START=$(date +%s%N)
DIRECT_RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST "$ANTHROPIC_BASE/messages" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $ANTHROPIC_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d "{
    \"model\": \"$MODEL\",
    \"messages\": $ANTHROPIC_MESSAGES,
    \"tools\": $ANTHROPIC_TOOLS,
    \"max_tokens\": 1024
  }" 2>&1)
DIRECT_END=$(date +%s%N)
DIRECT_MS=$(( (DIRECT_END - DIRECT_START) / 1000000 ))

DIRECT_HTTP=$(echo "$DIRECT_RESPONSE" | tail -1)
DIRECT_BODY=$(echo "$DIRECT_RESPONSE" | sed '$d')

echo "HTTP Status: $DIRECT_HTTP"
echo "Latency: ${DIRECT_MS}ms"
echo "Response size: $(echo "$DIRECT_BODY" | wc -c) bytes"
echo ""

# Parse response
if [ "$DIRECT_HTTP" = "200" ]; then
  echo "Content:"
  echo "$DIRECT_BODY" | python3 -c "
import json, sys
data = json.load(sys.stdin)
content = data.get('content', [])
text_blocks = [b for b in content if b.get('type') == 'text']
tool_blocks = [b for b in content if b.get('type') == 'tool_use']
print(text_blocks[0].get('text', 'No text')[:500] if text_blocks else 'No text')
print()
print('Tool calls:', len(tool_blocks))
print('Stop reason:', data.get('stop_reason'))
print('Usage:', data.get('usage', {}))
" 2>/dev/null || echo "$DIRECT_BODY" | head -20
else
  echo "Error response:"
  echo "$DIRECT_BODY" | head -20
fi

echo ""
echo "=== Comparison Summary ==="
echo "OmniRoute HTTP: $OMNIRoute_HTTP | Latency: ${OMNIRoute_MS}ms"
echo "Direct Anthropic HTTP: $DIRECT_HTTP | Latency: ${DIRECT_MS}ms"
echo ""
echo "Next: Compare response quality, tool call format, and usage metrics above."