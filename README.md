# Ekubo HuffRouter

This repository contains the Ekubo HuffRouter smart contracts, the TypeScript SDK for generating HuffRouter calldata, shared token lists, and incident-analysis scripts used to investigate the approval-draining calldata parsing bug documented in [incident-report](./incident-report/README.md).

## Repository Layout

- `contracts/`
  Huff and Solidity contract sources, Foundry tests, deployment scripts, and generated artifacts.
- `sdk/`
  TypeScript SDK for generating HuffRouter calldata, plus analysis and maintenance scripts.
- `tokens/`
  Shared token lists used by deployments, calldata decoding, and analysis tooling.
- `incident-report/`
  Incident write-ups plus checked-in analysis artifacts copied from local `sdk/incident-analysis` runs.

## Prerequisites

- Foundry
- `hnc` (HuffNeo compiler)
- Node.js and npm

The contracts workspace uses Foundry FFI and reads shared token data from `../tokens/`. See [contracts/foundry.toml](./contracts/foundry.toml).

## Contracts

Contract sources live under [contracts/src](./contracts/src). Tests live under [contracts/test](./contracts/test).

## SDK

The SDK package lives in [sdk/](./sdk) and exports calldata generation helpers from [sdk/src/index.ts](./sdk/src/index.ts).

Install dependencies:

```bash
cd sdk
npm install
```

Build the package:

```bash
npm run build
```

Run the SDK tests:

```bash
npm test
```

## Calldata Utilities

Useful scripts in [sdk/scripts](./sdk/scripts):

- [decode-calldata.ts](./sdk/scripts/decode-calldata.ts)
  Decodes HuffRouter calldata for inspection.
- [update-token-lists.ts](./sdk/scripts/update-token-lists.ts)
  Refreshes token list inputs used by the SDK and deployment flow.
- [incident-analysis.ts](./sdk/scripts/incident-analysis.ts)
  Scans historical router activity to recover exploit victims and losses for the approval-draining incident, and checks for still-live vulnerable approvals.

Decode calldata:

```bash
cd sdk
npx tsx scripts/decode-calldata.ts <calldata> [chainId]
```

## Approval-Drain Analysis

The approval-drain analysis entrypoint is [sdk/scripts/incident-analysis.ts](./sdk/scripts/incident-analysis.ts). It currently targets the affected mainnet router deployments and writes fresh reports under `sdk/incident-analysis/`.

A checked-in snapshot of the current mainnet analysis lives beside the postmortem in [incident-report](./incident-report/README.md).

Required environment:

```bash
export MAINNET_RPC_URL=...
```

Run the analysis:

```bash
cd sdk
npm run incident-analysis
```

The checked-in snapshot includes:

- `incident-report/incident-rows.csv`
- `incident-report/summary-by-victim.json`
- `incident-report/summary-by-token.csv`
- `incident-report/disqualified-victims.json`
- `incident-report/vulnerable-approvals.json`

Those files are copied from the corresponding runtime outputs in `sdk/incident-analysis/`, which remain gitignored.

## Notes

- The SDK package metadata is in [sdk/package.json](./sdk/package.json).
- Shared token data is intentionally versioned in this repository because both deployment-time code generation and incident analysis depend on historical token lists.
