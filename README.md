# Ekubo HuffRouter

This repository contains the Ekubo HuffRouter smart contracts, the TypeScript SDK for generating HuffRouter calldata, and shared token lists.

## Repository Layout

- `contracts/`
  Huff and Solidity contract sources, Foundry tests, deployment scripts, and generated artifacts.
- `sdk/`
  TypeScript SDK for generating HuffRouter calldata, plus maintenance scripts.
- `tokens/`
  Shared token lists used by deployments and the SDK.
- `incident-report/`
  Incident write-ups plus checked-in analysis artifacts.

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

## SDK Scripts

Useful scripts in [sdk/scripts](./sdk/scripts):

- [update-token-lists.ts](./sdk/scripts/update-token-lists.ts)
  Refreshes token list inputs used by the SDK and deployment flow.

Refresh token lists:

```bash
cd sdk
npm run update-token-lists
```

## Incident Report

A checked-in snapshot of the approval-drain analysis lives beside the postmortem in [incident-report](./incident-report/README.md). It includes:

- `incident-report/incident-rows.csv`
- `incident-report/summary-by-victim.json`
- `incident-report/summary-by-token.csv`
- `incident-report/disqualified-victims.json`
- `incident-report/vulnerable-approvals.json`

## Notes

- The SDK package metadata is in [sdk/package.json](./sdk/package.json).
- Shared token data is intentionally versioned in this repository because both deployment-time code generation and SDK calldata generation depend on it.
