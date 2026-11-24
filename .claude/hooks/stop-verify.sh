#!/usr/bin/env bash
# Stop gate: an agent session that changed code cannot end on a type error or failing tests.
# Run by Claude Code (.claude/settings.json Stop hook) and by omp (~/.omp/agent/extensions/stop-verify.ts).
#
# Exit 0: checks pass, or nothing changed since the last pass.
# Exit 2: checks fail. Claude Code and omp block the stop and hand stderr to the agent.
# Exit 1: checks still fail and nothing changed since that block, so the session may end
#         (stderr goes to the user). This caps the loop at one forced attempt per code state.
set -uo pipefail

TEST_CMD=(sh -c 'bun run typecheck && bun test')
PATHS=(':(glob)**/*.ts' ':(glob)**/*.tsx' ':(glob)**/*.js' 'package.json' 'bun.lock' 'tsconfig.json')
FAIL_LINES='error TS|\(fail\)|error:'

cd "$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
state="$(git rev-parse --absolute-git-dir)/stop-verify"
fp=$({
	git rev-parse HEAD
	git diff HEAD -- "${PATHS[@]}"
	git ls-files --others --exclude-standard -z -- "${PATHS[@]}" | xargs -0 -r sha1sum
} | sha1sum | cut -c1-40)

[ "$(cat "$state.pass" 2>/dev/null)" = "$fp" ] && exit 0
if [ "$(cat "$state.fail" 2>/dev/null)" = "$fp" ]; then
	echo "stop-verify: checks still fail and nothing changed since the last block; letting the session end." >&2
	exit 1
fi

log=$(mktemp)
trap 'rm -f "$log"' EXIT
if "${TEST_CMD[@]}" >"$log" 2>&1; then
	echo "$fp" >"$state.pass"
	rm -f "$state.fail"
	exit 0
fi
echo "$fp" >"$state.fail"
out=$(grep -E "$FAIL_LINES" "$log" | sort -u | head -40)
[ -n "$out" ] || out=$(tail -40 "$log")
{
	echo "stop-verify: 'bun run typecheck && bun test' fails. Fix it before finishing, or tell the user why it cannot pass."
	echo "$out"
} >&2
exit 2
