#!/bin/sh
# Verify requirements/FORK_CUSTOMIZATIONS.md against a DEPLOYED build, not just
# the source tree. Source presence and passing tests are not enough: the
# 2026-10-14 reconcile shipped docs without runtime effect, and the 2026-10-26
# reconcile kept the askpass code while the launcher wrapper pre-empted it.
#
# Usage: scripts/verify-fork-customizations.sh [--binary PATH] [--wrapper PATH]
#                                              [--tree DIR] [--tests] [--live]
#   --binary   deployed omp binary           (default ~/bin/omp)
#   --wrapper  launcher wrapper               (default ~/bin/myomp)
#   --tree     build tree to inspect          (default: this repo root)
#   --tests    also run the bun tests the checklist names
#   --live     also run omp through the wrapper and read the askpass env a tool
#              subprocess receives (uses a model call; needs network)
# Exit 0 only if every check passes. A check that cannot run FAILS.

BINARY="$HOME/bin/omp"
WRAPPER="$HOME/bin/myomp"
TREE="$(cd "$(dirname "$0")/.." && pwd)"
RUN_TESTS=0
RUN_LIVE=0
while [ $# -gt 0 ]; do
	case "$1" in
	--binary) BINARY="$2"; shift ;;
	--wrapper) WRAPPER="$2"; shift ;;
	--tree) TREE="$2"; shift ;;
	--tests) RUN_TESTS=1 ;;
	--live) RUN_LIVE=1 ;;
	*) echo "unknown option: $1" >&2; exit 2 ;;
	esac
	shift
done

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL  %s  -- %s\n' "$1" "$2"; }

[ -x "$BINARY" ] || { echo "FAIL  binary not executable: $BINARY" >&2; exit 1; }
[ -d "$TREE/packages" ] || { echo "FAIL  not a build tree: $TREE" >&2; exit 1; }
STR=$(mktemp "${TMPDIR:-/tmp}/forkverify.XXXXXX") || exit 1
trap 'rm -f "$STR"' EXIT
strings -a "$BINARY" >"$STR" 2>/dev/null
[ -s "$STR" ] || { echo "FAIL  no strings read from $BINARY" >&2; exit 1; }

in_binary() { # $1 label, $2 extended regex that must appear in the binary
	if grep -Eq -- "$2" "$STR"; then pass "$1"; else fail "$1" "not found in $BINARY"; fi
}

echo "binary:  $BINARY ($("$BINARY" --version 2>/dev/null))"
echo "wrapper: $WRAPPER"
echo "tree:    $TREE"
echo

# Row 1: RLM subsystem
N=$(git -C "$TREE" ls-files packages/rlm 2>/dev/null | wc -l | tr -d ' ')
if [ "$N" -ge 43 ]; then pass "row 1  packages/rlm has $N tracked files (>= 43)"; else fail "row 1  packages/rlm files" "$N < 43"; fi
# Rows 2-3: the ipython tool is in the binary and registered
in_binary "row 2  ipython tool name is in the binary" 'TOOL_NAME[0-9]* = "ipython"'
if grep -q 'ipython' "$TREE/packages/rlm/src/extension.ts" 2>/dev/null; then pass "row 3  ipython registered in extension.ts"; else fail "row 3  registration" "ipython not in extension.ts"; fi
# Row 4: askpass. The binary carries the constants, AND the wrapper must hand omp the yubi helper,
# because omp honours a usable parent SSH_ASKPASS first and YUBI_ASKPASS_PATH is not yet a fallback.
in_binary "row 4  askpass constants are in the binary" 'YUBI_ASKPASS_PATH[0-9]* = '
if [ -x "$HOME/bin/yubi-askpass" ]; then pass "row 4  ~/bin/yubi-askpass is executable"; else fail "row 4  yubi-askpass" "missing or not executable"; fi
FIRST=$(grep -n -E 'export SSH_ASKPASS=' "$WRAPPER" 2>/dev/null | head -1)
case "$FIRST" in
*yubi-askpass*) pass "row 4  wrapper exports yubi-askpass first" ;;
*) fail "row 4  wrapper askpass" "first SSH_ASKPASS export is not yubi-askpass: ${FIRST:-none}" ;;
esac
# Row 5: native modifiers
in_binary "row 5  native modifier code is in the binary" 'CGEventSourceFlagsState|CGEventSourceKeyState'
# Row 6: ignore entries
if grep -q 'kernel-state' "$TREE/.gitignore" 2>/dev/null; then pass "row 6  .gitignore ignores kernel-state"; else fail "row 6  .gitignore" "no kernel-state entry"; fi
# Row 7: the two TOOL_DESCRIPTION guardrail lines reach the binary
in_binary "row 7a write-path rule is in the binary" 'statically-inspectable string'
in_binary "row 7b dill bare-filename rule is in the binary" 'with a bare filename only'
# Row 8: per-spawn model
in_binary "row 8  per-spawn model assignment is in the binary" 'spawn\.model = item\.model'
# Row 9: shell env parity
in_binary "row 9  shell-snapshot-fn-env is in the binary" 'shell-snapshot-fn-env'

if [ "$RUN_TESTS" = 1 ]; then
	echo
	for t in packages/rlm packages/coding-agent/test/non-interactive-env.test.ts \
		packages/coding-agent/test/spawn-model.test.ts packages/tui/test/native-modifier-detection.test.ts \
		packages/coding-agent/test/extension-session-shell-env.test.ts; do
		if (cd "$TREE" && bun test "$t" >/dev/null 2>&1); then pass "tests  $t"; else fail "tests  $t" "bun test failed"; fi
	done
fi

if [ "$RUN_LIVE" = 1 ]; then
	echo
	OUT=$(cd /tmp && OMP_BIN="$BINARY" "$WRAPPER" -p 'Use the bash tool to run exactly: echo "ASKPASS=$SSH_ASKPASS" and reply with only that output line.' 2>&1 | grep -E '^ASKPASS=' | head -1)
	case "$OUT" in
	*/yubi-askpass) pass "live   a tool subprocess gets $OUT" ;;
	*) fail "live   askpass seen by a tool subprocess" "got '${OUT:-nothing}', expected .../yubi-askpass" ;;
	esac
fi

echo
printf '%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
