#!/usr/bin/env bash
# Proves scripts/check-network-guard.sh fails as a whole when any one step fails, including the step whose failure used to
# be lost (the bypass-import self-test followed by a passing scan). Runs the real gate script against stubbed steps.
set -uo pipefail

gate="$(cd "$(dirname "$0")" && pwd)/check-network-guard.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/scripts" "$tmp/bin"

# Stubs, steered by environment variables. A healthy run: both in-process canaries fail with the guard's message, the
# kernel canary fails with EAI_AGAIN, and the import check passes in both modes.
cat >"$tmp/bin/yarn" <<'STUB'
#!/usr/bin/env bash
[ "${CANARY:-ok}" = reaches ] && exit 0
if [ "${CANARY:-ok}" = other ]; then echo 'some unrelated failure'; else echo 'Test attempted outbound network access'; fi
exit 1
STUB
cat >"$tmp/scripts/test-unit-isolated.sh" <<'STUB'
#!/usr/bin/env bash
[ "${KERNEL:-ok}" = reaches ] && exit 0
if [ "${KERNEL:-ok}" = other ]; then echo 'some unrelated failure'; else echo 'getaddrinfo EAI_AGAIN example.com'; fi
exit 1
STUB
cat >"$tmp/scripts/check-bypass-imports.js" <<'STUB'
#!/usr/bin/env bash
if [ "${1:-}" = --self-test ]; then exit "${SELF_TEST_EXIT:-0}"; fi
exit "${SCAN_EXIT:-0}"
STUB
chmod +x "$tmp/bin/yarn" "$tmp/scripts/"*

run_gate() { (cd "$tmp" && PATH="$tmp/bin:$PATH" "$@" bash "$gate" >"$tmp/out" 2>&1); }
expect() { # expected exit (0 or 1), description, then VAR=value settings
  local want="$1" description="$2" status=0
  shift 2
  run_gate env "$@" || status=$?
  if [ "$status" -ne "$want" ]; then
    echo "gate wiring self-test failed: ${description} (exit ${status}, expected ${want})" >&2
    cat "$tmp/out" >&2
    exit 1
  fi
}

expect 0 'healthy: valid canaries, passing import check' CANARY=ok
expect 1 'import self-test fails while the scan passes' SELF_TEST_EXIT=1 SCAN_EXIT=0
expect 1 'import scan fails while the self-test passes' SELF_TEST_EXIT=0 SCAN_EXIT=1
expect 1 'import self-test could not read its fixtures (exit 2) while the scan passes' SELF_TEST_EXIT=2 SCAN_EXIT=0
expect 1 'import scan could not read the source tree (exit 2) while the self-test passes' SELF_TEST_EXIT=0 SCAN_EXIT=2
expect 1 'an in-process canary passes' CANARY=reaches
expect 1 'an in-process canary fails for another reason' CANARY=other
expect 1 'the kernel canary reaches the network' KERNEL=reaches
expect 1 'the kernel canary fails for another reason' KERNEL=other
echo 'network guard gate wiring: self-test passed'
