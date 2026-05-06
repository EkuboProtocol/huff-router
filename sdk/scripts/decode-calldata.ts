#!/usr/bin/env tsx
import type { Hex } from "viem";
import { decodeHyperRouterCalldata } from "./hyperrouter-calldata.ts";

const [, , calldataArg, chainIdArg] = process.argv;

if (!calldataArg) {
    process.stderr.write("Usage: tsx scripts/decode-calldata.ts <calldata> [chainId]\n");
    process.exit(1);
}

const hex = calldataArg.startsWith("0x") ? calldataArg as Hex : `0x${calldataArg}` as Hex;
const chainId = chainIdArg ? BigInt(chainIdArg) : null;

try {
    const decoded = decodeHyperRouterCalldata(hex, chainId, { allowTrailingBytes: true });
    process.stdout.write(JSON.stringify(decoded, null, 2) + "\n");
} catch (error) {
    process.stderr.write(`Error: ${(error as Error).message}\n`);
    process.exit(1);
}
