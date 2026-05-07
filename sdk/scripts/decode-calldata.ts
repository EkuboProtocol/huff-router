#!/usr/bin/env tsx
import type { Hex } from "viem";
import { decodeHuffRouterCalldata } from "./huffrouter-calldata.ts";
import { inspect } from "node:util";

const [, , calldataArg, chainIdArg] = process.argv;

if (!calldataArg) {
    console.error("Usage: tsx scripts/decode-calldata.ts <calldata> [chainId]");
    process.exit(1);
}

const hex = calldataArg.startsWith("0x") ? calldataArg as Hex : `0x${calldataArg}` as Hex;
const chainId = chainIdArg ? BigInt(chainIdArg) : null;

try {
    const decoded = decodeHuffRouterCalldata(hex, chainId, { allowTrailingBytes: true });
    console.log(inspect(decoded, {depth: null}));
} catch (error) {
    console.error(`Error: ${(error as Error).message}\n`);
    process.exit(1);
}
