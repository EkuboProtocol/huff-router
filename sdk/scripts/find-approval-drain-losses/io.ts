import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    createPublicClient,
    decodeAbiParameters,
    decodeFunctionResult,
    getAddress,
    hexToBigInt,
    hexToString,
    http,
    parseAbi,
} from "viem";
import type { EIP1474Methods, Hex, HttpTransport, PublicClient } from "viem";
import type {
    AffectedDeployments,
    IncidentRow,
    TokenLossSummary,
    VictimSummary,
} from "./search.ts";
import {
    V2_CORE_ADDRESS,
    V3_CORE_ADDRESS,
    mapConcurrent,
} from "./search.ts";
import {
    TOKEN_LIST_05CE00D,
    TOKEN_LIST_06AC834,
    TOKEN_LIST_3759F9B,
} from "./token-lists.ts";

const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../out");
const SYMBOL_ABI = parseAbi(["function symbol() view returns (string)"]);
const DECIMALS_ABI = parseAbi(["function decimals() view returns (uint8)"]);

export interface ChainConfig {
    affectedDeployments: AffectedDeployments;
    chainId: bigint;
    client: Client;
    name: string;
}

export interface TokenMetadata {
    decimals?: number;
    symbol?: string;
}

export type Client = PublicClient<HttpTransport, undefined, undefined, [...EIP1474Methods, {
  Method: "trace_filter"
  Parameters: [{count: number, fromBlock: Hex, toAddress: Hex[]}]
  ReturnType: unknown
}]>

export function getChainConfigs(): ChainConfig[] {
    const mainnetRpcUrl = process.env.MAINNET_RPC_URL;

    if (!mainnetRpcUrl) {
        throw new Error("MAINNET_RPC_URL must be set");
    }

    return [
        {
            affectedDeployments: {
                deployments: [
                    {
                        core: V2_CORE_ADDRESS,
                        router: getAddress("0x8f52903d17e2d8d6c77d1a1de0cc975b6b5a0d15"),
                        routerGeneration: "V2",
                        tokenList: TOKEN_LIST_05CE00D,
                    },
                    {
                        core: V2_CORE_ADDRESS,
                        router: getAddress("0x8ccb1ffd5c2aa6bd926473425dea4c8c15de60fd"),
                        routerGeneration: "V2",
                        tokenList: TOKEN_LIST_3759F9B,
                    },
                    {
                        core: V3_CORE_ADDRESS,
                        router: getAddress("0x4f168f17923435c999f5c8565acab52c2218edf2"),
                        routerGeneration: "V3",
                        tokenList: TOKEN_LIST_06AC834,
                    },
                ],
                startBlock: 23_018_974n,
            },
            chainId: 1n,
            client: createPublicClient({ transport: http(mainnetRpcUrl) }),
            name: "mainnet",
        },
    ];
}

export function rowsToCsv(rows: IncidentRow[]): string {
    const headers: (keyof IncidentRow)[] = [
        "chainId",
        "router",
        "routerGeneration",
        "txHash",
        "blockNumber",
        "txFrom",
        "routerCaller",
        "victim",
        "victimToken",
        "attackerToken",
        "rawAmount",
        "traceAddress",
    ];

    const lines = [
        headers.join(","),
        ...rows.map((row) => headers.map((header) => escapeCsv(row[header])).join(",")),
    ];

    return `${lines.join("\n")}\n`;
}

export async function loadTokenMetadataMap(
    client: Pick<Client, "call">,
    tokens: readonly `0x${string}`[],
): Promise<Map<`0x${string}`, TokenMetadata>> {
    const metadataByToken = new Map<`0x${string}`, TokenMetadata>();

    await mapConcurrent(tokens, 8, async (token) => {
        const [symbolData, decimalsData] = await Promise.all([
            callToken(client, token, "0x95d89b41"),
            callToken(client, token, "0x313ce567"),
        ]);

        metadataByToken.set(token, {
            ...(typeof symbolData !== "undefined" ? { symbol: decodeSymbol(symbolData) } : {}),
            ...(typeof decimalsData !== "undefined" ? { decimals: decodeDecimals(decimalsData) } : {}),
        });
    });

    return metadataByToken;
}

export async function writeReports(
    incidentRows: IncidentRow[],
    summaries: VictimSummary,
    tokenSummaries: TokenLossSummary[],
    tokenMetadataByToken: ReadonlyMap<`0x${string}`, TokenMetadata>,
): Promise<string> {
    await mkdir(OUT_DIR, { recursive: true });
    await writeFile(path.join(OUT_DIR, "incident-rows.csv"), rowsToCsv(incidentRows));
    await writeFile(path.join(OUT_DIR, "summary-by-victim.json"), JSON.stringify(summaries, null, 2) + "\n");
    await writeFile(path.join(OUT_DIR, "summary-by-token.csv"), tokenSummariesToCsv(tokenSummaries, tokenMetadataByToken));
    return OUT_DIR;
}

async function callToken(
    client: Pick<Client, "call">,
    token: `0x${string}`,
    data: Hex,
): Promise<Hex | undefined> {
    try {
        const result = await client.call({ data, to: token });
        return result.data;
    } catch {
        return undefined;
    }
}

function decodeSymbol(data: Hex): string | undefined {
    try {
        const decoded = decodeFunctionResult({
            abi: SYMBOL_ABI,
            data,
        });

        return typeof decoded === "string" && decoded.length > 0 ? decoded : undefined;
    } catch {
        try {
            const [bytes32] = decodeAbiParameters([{ type: "bytes32" }], data);
            const decoded = hexToString(bytes32, { size: 32 }).replace(/\u0000+$/g, "");

            return decoded.length > 0 ? decoded : undefined;
        } catch {
            return undefined;
        }
    }
}

function decodeDecimals(data: Hex): number | undefined {
    try {
        const decoded = decodeFunctionResult({
            abi: DECIMALS_ABI,
            data,
        });

        return typeof decoded === "number" ? decoded : Number(decoded);
    } catch {
        try {
            return Number(hexToBigInt(data));
        } catch {
            return undefined;
        }
    }
}

function escapeCsv(value: string | number | undefined): string {
    if (typeof value === "undefined") {
        return "";
    }

    const raw = String(value);
    if (!/[,"\n]/.test(raw)) {
        return raw;
    }

    return `"${raw.replaceAll("\"", "\"\"")}"`;
}

function tokenSummariesToCsv(
    rows: TokenLossSummary[],
    tokenMetadataByToken: ReadonlyMap<`0x${string}`, TokenMetadata>,
): string {
    const headers = ["token", "symbol", "amount"] as const;
    const lines = [
        headers.join(","),
        ...rows.map((row) => {
            const metadata = tokenMetadataByToken.get(row.token);
            return [
                escapeCsv(row.token),
                escapeCsv(metadata?.symbol),
                escapeCsv(formatDisplayAmount(row.amount, metadata?.decimals)),
            ].join(",");
        }),
    ];

    return `${lines.join("\n")}\n`;
}

function formatDisplayAmount(rawAmount: string, decimals?: number): string {
    if (typeof decimals !== "number" || decimals < 0) {
        return rawAmount;
    }

    const amount = BigInt(rawAmount);
    if (decimals === 0) {
        return amount.toString();
    }

    const base = 10n ** BigInt(decimals);
    const whole = amount / base;
    const fraction = amount % base;

    if (fraction === 0n) {
        return whole.toString();
    }

    const fractionString = fraction
        .toString()
        .padStart(decimals, "0")
        .replace(/0+$/u, "");

    return `${whole}.${fractionString}`;
}
