# AGENTS.md: zeno-client-ts

TypeScript client for the Zeno L2. ESM, Node `^22.23.0 || ^24.17.0 || >=26.1.0` and browsers, TypeScript strict. It holds no keys and sends nothing.

## Boundary rule

A helper belongs in `znn-typescript-sdk` when go-zenon's Go code implements or enforces it. It belongs here when only the executor, the gateway or a runtime defines it. Never re-export `znn-typescript-sdk` from this package. Import Settlement builders, the state verifier and `SettlementStorage` from it directly.

## Layout

```
src/
  codec.ts      ZenoReader, ZenoWriter, ZenoCodecError (SPEC 14.1 and 27.0)
  derive.ts     chainId, l1Caller, contractId, smtKey, metadata
  decode.ts     receipt, execution result, outbox message, DA bundle and return data decoders
  input.ts      encodeInput, inputHash, inputRoot, merkleRoot
  constants.ts  InputKind, ReceiptStatus, codec bounds
  gateway/      GatewayClient, its HTTP and WebSocket transports, typed errors, verification, contracts/1 profile helpers
  interface/    interface file types and parser, zeno-selector-v1 encoder, prepareDeploy, prepareCall
  runtime/      path derivation and interface encoder registries, WASM path derivation
test/           Mocha specs; test/fixtures holds hash-pinned vectors and recorded gateway responses
```

## Commands

```bash
npm test
npm run lint
npm run typecheck
npm run build
```

Run the tests after every code change. The development dependency `znn-typescript-sdk` installs from the `digitalSloth/znn-typescript-sdk` commit that `package.json` pins. To move to another commit, change it in `package.json` and run `npm install`.

## Conventions

- Named exports only, no default exports.
- Hashing uses `@noble/hashes` `sha3_256`. SHA3-256 is not Keccak-256.
- Fixtures are never edited by hand.
- Error messages quote a gateway or caller value only through `show` (`src/format.ts`).
- Branches are `feature/<short-description>`. Commits are `feat|fix|chore|docs|test: lower case sentence` plus a body. Never commit to `main`.

## Gateway fixtures

`test/fixtures/gateway/gateway-go.json` holds real gateway responses. zeno-executor writes it:

```bash
GATEWAY_SDK_FIXTURE_OUT=<path> go test ./internal/gateway -run TestDumpGatewaySdkFixture -count=1
```

Never edit it by hand. A test that needs a response the recording lacks (a tampered proof, an error code the dump does not reach) builds it inline and says so. `ZENO_GATEWAY_URL` points the gated live spec at a running gateway.
