#!/usr/bin/env bash
# Consumes the built package the way a source-linked consumer does (node_modules/@nchamo/sdk -> this directory): a
# consumer typechecks against the emitted declarations, then loads buildSDK from dist. Run after `yarn build`.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
consumer=$(mktemp -d)
trap 'rm -rf "$consumer"' EXIT
mkdir -p "$consumer/node_modules/@nchamo"
ln -s "$repo" "$consumer/node_modules/@nchamo/sdk"

cat >"$consumer/consumer.ts" <<'TS'
import { buildSDK } from '@nchamo/sdk';

const sdk = buildSDK({ quotes: { sourceList: { type: 'local' } } });
const sources = Object.keys(sdk.quoteService.supportedSources());
if (sources.length === 0) throw new Error('buildSDK loaded without any quote source');
console.log(`consumer smoke: buildSDK loaded from dist with ${sources.length} quote sources`);
TS

"$repo/node_modules/.bin/tsc" --strict --target es2021 --module commonjs --moduleResolution node --esModuleInterop \
  --skipLibCheck --outDir "$consumer/out" "$consumer/consumer.ts"
(cd "$consumer" && node out/consumer.js)
