#!/bin/bash
# Quick local test for the task pipeline's claude spawn.
# Runs the same command that investigate() would run, capturing both streams.
set -euo pipefail

unset CLAUDECODE

CWD="${1:-.}"
PROMPT='Return exactly this JSON (no markdown fences): {"rating":"good","summary":"test task spawn","reasoning":"test","pros":["works"],"cons":[],"filesExamined":[]}'

echo "=== Testing claude --print --output-format stream-json --verbose ==="
echo "cwd: $CWD"
echo ""

timeout 30 claude \
  --print \
  --output-format stream-json \
  --allowedTools 'Read,Glob,Grep' \
  --max-turns 2 \
  --verbose \
  "$PROMPT" \
  > /tmp/task-spawn-stdout.txt \
  2> /tmp/task-spawn-stderr.txt \
  || true

RC=$?
echo "exit=$RC"
echo "stdout bytes: $(wc -c < /tmp/task-spawn-stdout.txt)"
echo "stderr bytes: $(wc -c < /tmp/task-spawn-stderr.txt)"
echo ""

if [ -s /tmp/task-spawn-stderr.txt ]; then
  echo "=== STDERR (stream-json events) ==="
  while IFS= read -r line; do
    TYPE=$(echo "$line" | python3 -c "import sys,json; print(json.loads(sys.stdin.readline()).get('type','non-json'))" 2>/dev/null || echo "non-json")
    echo "  event: $TYPE"
  done < /tmp/task-spawn-stderr.txt
  echo ""
fi

if [ -s /tmp/task-spawn-stdout.txt ]; then
  echo "=== STDOUT ==="
  head -5 /tmp/task-spawn-stdout.txt
  echo ""
fi

if [ ! -s /tmp/task-spawn-stderr.txt ] && [ ! -s /tmp/task-spawn-stdout.txt ]; then
  echo "⚠ NO OUTPUT on either stream — claude may be stuck on auth or hanging"
fi
