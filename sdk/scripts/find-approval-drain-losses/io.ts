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
import type { Hex } from "viem";
import type {
    AffectedDeployments,
    IncidentRowWithMetadata,
    TokenMetadata,
    VictimSummary,
} from "./search.ts";
import {
    V2_CORE_ADDRESS,
    V3_CORE_ADDRESS,
    mapConcurrent,
    tokenKey,
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
    client: ReturnType<typeof createPublicClient>;
    name: string;
}

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

export function rowsToCsv(rows: IncidentRowWithMetadata[]): string {
    const headers: (keyof IncidentRowWithMetadata)[] = [
        "chainId",
        "router",
        "routerGeneration",
        "txHash",
        "blockNumber",
        "txFrom",
        "routerCaller",
        "victim",
        "token",
        "tokenSymbol",
        "tokenDecimals",
        "rawAmount",
        "traceAddress",
    ];

    const lines = [
        headers.join(","),
        ...rows.map((row) => headers.map((header) => escapeCsv(row[header])).join(",")),
    ];

    return `${lines.join("\n")}\n`;
}

export async function loadTokenMetadata({
    call,
}: {
    call: (token: `0x${string}`, data: Hex) => Promise<Hex | undefined>;
}, token: `0x${string}`): Promise<TokenMetadata> {
    const [symbolData, decimalsData] = await Promise.all([
        call(token, "0x95d89b41"),
        call(token, "0x313ce567"),
    ]);

    return {
        ...(typeof decimalsData !== "undefined" ? { decimals: decodeDecimals(decimalsData) } : {}),
        ...(typeof symbolData !== "undefined" ? { symbol: decodeSymbol(symbolData) } : {}),
    };
}

export async function loadTokenMetadataMap({
    chainId,
    client,
    concurrency,
    tokens,
}: {
    chainId: bigint;
    client: {
        call(args: { data: Hex; to: `0x${string}` }): Promise<{ data?: Hex }>;
    };
    concurrency: number;
    tokens: readonly `0x${string}`[];
}): Promise<Map<string, TokenMetadata>> {
    const metadataByToken = new Map<string, TokenMetadata>();

    await mapConcurrent(tokens, concurrency, async (token) => {
        const metadata = await loadTokenMetadata(
            {
                call: async (address, data) => {
                    try {
                        const result = await client.call({ data, to: address });
                        return result.data;
                    } catch {
                        return undefined;
                    }
                },
            },
            getAddress(token),
        );

        metadataByToken.set(tokenKey(chainId, token), metadata);
    });

    return metadataByToken;
}

export async function writeReports(
    incidentRows: IncidentRowWithMetadata[],
    summaries: VictimSummary[],
): Promise<string> {
    await mkdir(OUT_DIR, { recursive: true });
    await writeFile(path.join(OUT_DIR, "incident-rows.csv"), rowsToCsv(incidentRows));
    await writeFile(path.join(OUT_DIR, "summary-by-victim.json"), JSON.stringify(summaries, null, 2) + "\n");
    return OUT_DIR;
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
