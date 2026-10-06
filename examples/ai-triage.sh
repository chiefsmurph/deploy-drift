#!/bin/bash
# Run git-drift and, when anything drifted, ask Claude (Claude Code, headless, NO tools) for a fix plan.
# The model only reads the report; it can't run commands. Usage: ai-triage.sh [git-drift args...]
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
report=$(npx -y git-drift -q -e -f json "$@"); code=$?
[ "$code" = 0 ] && { echo "git-drift: all clear"; exit 0; }
cd "$(mktemp -d)"   # neutral folder: no project settings or CLAUDE.md
printf '%s\n\n%s\n' "$(cat "$here/ai-triage-prompt.md")" "$report" |
  claude -p --tools "" --strict-mcp-config --model sonnet --max-turns 1
exit "$code"
