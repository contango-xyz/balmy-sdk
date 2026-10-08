#!/usr/bin/env bash
# Proves the unit gate trips on outbound access: each canary reaches the network on purpose and must FAIL with the guard's
# message, including when the test swallows the guard's error. A bare failure (e.g. an offline runner) is not accepted.
# No errexit on purpose: the canaries are expected to fail, so every step checks its own status and exits explicitly.
# scripts/check-network-guard.selftest.sh proves this wiring fails the gate when any step's status is lost.
set -uo pipefail

for canary in outbound swallowed; do
  output=$(yarn -s jest --forceExit --testMatch "**/${canary}.canary.ts" 2>&1)
  status=$?
  if [ "$status" -eq 0 ]; then
    echo "network guard canary '${canary}' passed: the unit gate does not stop outbound access" >&2
    exit 1
  fi
  if ! grep -Eq 'Network access denied in unit tests|attempted outbound network access' <<<"$output"; then
    echo "network guard canary '${canary}' failed for another reason:" >&2
    echo "$output" >&2
    exit 1
  fi
done

# The container boundary on its own, with the in-process guard switched off: a request must still fail.
output=$(scripts/test-unit-isolated.sh -c jest.kernel-canary.config.js --testMatch '**/outbound.canary.ts' 2>&1) && {
  echo 'the isolated container reached the network' >&2
  exit 1
}
grep -Eq 'EAI_AGAIN|ENETUNREACH' <<<"$output" || {
  echo "isolated canary failed for another reason:" >&2
  echo "$output" >&2
  exit 1
}

# What neither layer's author could see: imports that bypass the in-process guard are limited to the reviewed files.
for mode in --self-test ''; do
  scripts/check-bypass-imports.js $mode || {
    echo "bypass import check failed${mode:+ ($mode)}" >&2
    exit 1
  }
done
