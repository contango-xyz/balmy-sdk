## OKX V6 adapter repair (CTG-832)

The existing `okx-dex` source uses V6 for swap and approval requests. It keeps the
same quote-source interface, source ID, chain metadata and transaction builder.
The repair is an offline change; it supplies no live acceptance or enablement
evidence. Provider details remain inside the adapter (T-016/T-017/T-018).

Official documentation checked on 2026-10-08:

- [Swap](https://web3.okx.com/onchainos/dev-docs/trade/dex-swap): the V6 swap
  request uses `chainIndex`, integer base-unit `amount`, `slippagePercent` and
  `userWalletAddress`. Slippage is a percentage: `0.5` means 0.5%, so the SDK
  percentage is sent unchanged. The optional `swapReceiverAddress` carries a
  distinct recipient; omission leaves the documented taker default.
- [Approval](https://web3.okx.com/onchainos/dev-docs/trade/dex-approve-transaction):
  V6 approval uses `chainIndex`, `tokenContractAddress` and `approveAmount` and
  returns `dexContractAddress`. The adapter retains its existing maximum-uint256
  approval query and skips that request entirely for native sells.
- [Authentication](https://web3.okx.com/onchainos/dev-docs/home/api-access-and-usage):
  ISO timestamps and HMAC-SHA256/base64 headers remain unchanged. Its prose
  example omits the query, while the Postman and JavaScript examples include it.
  The adapter signs the exact path plus query it sends, as before. A fixture
  verifies that construction with Node's independent crypto implementation;
  provider acceptance remains unverified.
- [Supported chains](https://web3.okx.com/onchainos/dev-docs/trade/dex-get-aggregator-supported-chains):
  the docs describe a query endpoint, not evidence that the existing adapter
  chain list still works. This repair does not call that endpoint or change the
  list. Every chain and transaction branch claimed enabled needs its own
  separately approved Stage 2b evidence.

## Response boundary and errors

Ajv validates each entire success envelope once, before destructuring or bigint
conversion: string `code: "0"`, nonempty array data, required router/transaction
fields, decimal integer strings, EVM addresses and nonempty even-length calldata.
Both swap and approval use the same transport boundary and existing `failed(...)`
error model. Ajv 8.12.0 is an exact runtime dependency because production
validation uses it. After CTG-835 removed the tooling that previously supplied
Ajv, Yarn 1.22.22 regenerated its six lock entries from the merged foundation,
preserving Ajv's tested version, registry URL and integrity. The regenerated
transitive punycode entry resolves to 2.3.1.

The swap docs call `tx.gas` an estimated gas limit, recommend a 50% increase and
point to another endpoint for accuracy. This repair preserves the adapter's
existing estimate mapping, without adding a buffer or another request. Missing
or malformed gas fails the source; its availability and suitability per chain
are unresolved. Missing/null `tx.value` retains the existing zero default.

HTTP errors, rejected requests, invalid JSON and invalid/application-error
envelopes all become source failures with fixed diagnostic text. The adapter
discards provider messages, bodies and original exceptions: even a truncated
message can echo credentials, signatures or a signed URL. Ajv validation errors
are not exposed either. Fixtures cover credentials shorter than eight characters
and malicious echoes through both endpoints and every error path. Quote-service
fixtures prove that another viable source remains eligible as the best quote.

## Verification and delivery boundaries

Fixtures live only under `test/unit/services/quotes/sources/fixtures`; no test
helpers enter production. No provider, credential or enablement change is part
of this repair. Live integration tests are outside Stage 2a and must not be run
for its verification.

CTG-835 owns common test infrastructure and the safe offline CI gate. Its merged
foundation is `4cbe856d8fc86379edb33cfe19da384d36d7ab26`; CTG-832 rebases onto
that commit and runs its complete offline gate before publication. Independent
review uses the exact published head. The
first CTG-836 consumer gitlink must include both reviewed, merged changes.

The [approved replacement plan](https://multica.int.contangov3.com/issues/CTG-827#comment-01a11c05-176f-7cba-98c3-0080440c5ec2)
carries the Stage 2a app-QA waiver forward: this is an offline adapter-only change
with no app or consumer edit, so app QA belongs to CTG-836 adoption. This waiver
is not an app-QA PASS.
Signing acceptance, chain support and gas semantics also remain Stage 2b gaps.
