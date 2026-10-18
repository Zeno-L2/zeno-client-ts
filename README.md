# zeno-client-ts

TypeScript client for the Zeno L2 on Zenon. It covers everything the executor, the gateway and the contract runtimes define, and depends on `znn-typescript-sdk` for everything go-zenon implements.

| Area | Status |
|---|---|
| Codec, derivations, decoders and input encoding | Built |
| Gateway client, verification and `contracts/1` helpers | Built |
| Contract interface files, the `zeno-selector-v1` encoder, `prepareDeploy` and `prepareCall` | Built. Byte equality is tested against zeno-contract-sdk-rs's committed counter and reference vault interface files |

The SDK holds no keys and sends nothing. It reads, decodes and verifies. A caller turns its output into a send with the `znn-typescript-sdk` builders.

## Install

Neither package is published to npm yet, so install both from GitHub. `znn-typescript-sdk` is a peer dependency:

```bash
npm install github:digitalSloth/znn-typescript-sdk#<commit> github:Zeno-L2/zeno-client-ts#<commit>
```

Each package's `prepare` script builds its `dist/` during the install.

In this repository, `npm install` installs the development dependency `znn-typescript-sdk` from the `digitalSloth/znn-typescript-sdk` commit that `package.json` pins.

## Commands

```bash
npm test         # Mocha + Chai through tsx
npm run lint     # ESLint
npm run typecheck
npm run build    # clean, lint, tsc
```
