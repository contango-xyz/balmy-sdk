#!/usr/bin/env bash
# Runs the unit suite (or the given jest arguments) in a container with NO network interface but loopback, so the egress
# boundary is the kernel's, not ours. Needs installed dependencies and a container runtime.
# The image is pinned by digest (the multi-arch index of node:24.11.1-slim) so local runs and CI use the same bytes.
set -euo pipefail
NODE_IMAGE="${NODE_IMAGE:-docker.io/library/node:24.11.1-slim@sha256:48abc13a19400ca3985071e287bd405a1d99306770eb81d61202fb6b65cf0b57}"
ARGS=("$@")
[ ${#ARGS[@]} -gt 0 ] || ARGS=(--testPathPattern=test/unit)
exec docker run --rm --network none -e HOME=/tmp \
  -v "$PWD:/w:ro,Z" -w /w "$NODE_IMAGE" node node_modules/.bin/jest --forceExit "${ARGS[@]}"
