import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    createPublicClient,
    decodeAbiParameters,
    decodeFunctionResult,
    encodeEventTopics,
    encodeFunctionData,
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
    VULNERABLE_APPROVAL_TOKEN_LIST,
} from "./token-lists.ts";

const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../incident-analysis");
const SYMBOL_ABI = parseAbi(["function symbol() view returns (string)"]);
const DECIMALS_ABI = parseAbi(["function decimals() view returns (uint8)"]);
const ALLOWANCE_ABI = parseAbi(["function allowance(address owner, address spender) view returns (uint256)"]);
const BALANCE_OF_ABI = parseAbi(["function balanceOf(address owner) view returns (uint256)"]);
const APPROVAL_EVENT = parseAbi(["event Approval(address indexed owner, address indexed spender, uint256 value)"])[0];
const [APPROVAL_EVENT_TOPIC] = encodeEventTopics({
    abi: [APPROVAL_EVENT],
    eventName: "Approval",
});
const MAX_UINT256 = (1n << 256n) - 1n;
const APPROVAL_LOG_TOKEN_CHUNK_SIZE = 50;
const APPROVAL_LOG_CONCURRENCY = 4;
const APPROVAL_READ_CONCURRENCY = 16;

export interface MainnetConfig {
    affectedDeployments: AffectedDeployments;
    client: Client;
    vulnerableApprovalTokens: readonly `0x${string}`[];
}

export interface TokenMetadata {
    decimals?: number;
    symbol?: string;
}

export interface DisqualifiedApproval {
    blockNumber: number;
    spender: `0x${string}`;
    token: `0x${string}`;
    txFrom: `0x${string}`;
    txHash: `0x${string}`;
    value: string;
}

export type DisqualifiedVictimReport = Partial<Record<`0x${string}`, DisqualifiedApproval[]>>;

export interface VulnerableApprovalEntry {
    amount: string;
    effective: string;
    owner: `0x${string}`;
}

export type VulnerableApprovalByToken = Partial<Record<`0x${string}`, VulnerableApprovalEntry[]>>;

export type VulnerableApprovalSummary = Partial<Record<`0x${string}`, VulnerableApprovalByToken>>;

interface RawRpcLog {
    address: `0x${string}`;
    blockNumber?: Hex | null;
    data: Hex;
    logIndex?: Hex | null;
    removed?: boolean;
    topics: Hex[];
    transactionIndex?: Hex | null;
}

interface ApprovalLog {
    blockNumber: number;
    logIndex: number;
    owner: `0x${string}`;
    spender: `0x${string}`;
    token: `0x${string}`;
    transactionIndex: number;
    value: bigint;
}

interface CurrentApproval {
    amount: bigint;
    owner: `0x${string}`;
    spender: `0x${string}`;
    token: `0x${string}`;
}

export type Client = PublicClient<HttpTransport, undefined, undefined, [...EIP1474Methods, {
  Method: "trace_filter"
  Parameters: [{count: number, fromBlock: Hex, toAddress: Hex[]}]
  ReturnType: unknown
}]>

export function getMainnetConfig(): MainnetConfig {
    const mainnetRpcUrl = process.env.MAINNET_RPC_URL;

    if (!mainnetRpcUrl) {
        throw new Error("MAINNET_RPC_URL must be set");
    }

    return {
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
        client: createPublicClient({ transport: http(mainnetRpcUrl) }),
        vulnerableApprovalTokens: VULNERABLE_APPROVAL_TOKEN_LIST,
    };
}

export function rowsToCsv(rows: IncidentRow[]): string {
    const headers: (keyof IncidentRow)[] = [
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

export async function findDisqualifiedVictims(
    client: Pick<Client, "getLogs" | "getTransaction">,
    latestExploitOrderByVictim: ReadonlyMap<`0x${string}`, {
        blockNumber: number;
        transactionIndex: number;
    }>,
    routers: readonly `0x${string}`[],
    fromBlock: bigint,
): Promise<DisqualifiedVictimReport> {
    const routerSet = new Set(routers.map((router) => router.toLowerCase()));

    const results = await mapConcurrent([...latestExploitOrderByVictim.keys()], 8, async (victim) => {
        const latestExploitOrder = latestExploitOrderByVictim.get(victim);
        if (!latestExploitOrder) {
            return null;
        }

        const logs = await client.getLogs({
            event: APPROVAL_EVENT,
            fromBlock,
            args: {
                owner: victim,
            },
        });

        const candidateLogs = logs.filter((log) => {
            if (!log.transactionHash || !log.args.spender || typeof log.args.value === "undefined") {
                return false;
            }

            return routerSet.has(getAddress(log.args.spender).toLowerCase()) && log.args.value > 0n;
        });

        if (candidateLogs.length === 0) {
            return null;
        }

        const txFromByHash = new Map<`0x${string}`, `0x${string}`>();
        const txHashes = [...new Set(candidateLogs.map((log) => log.transactionHash).filter((hash): hash is `0x${string}` => typeof hash === "string"))];

        await mapConcurrent(txHashes, 8, async (txHash) => {
            const transaction = await client.getTransaction({ hash: txHash });
            txFromByHash.set(txHash, getAddress(transaction.from));
        });

        const disqualifiedApprovals = candidateLogs
            .filter((log) => {
                const approvalBlock = Number(log.blockNumber ?? fromBlock);
                const approvalTransactionIndex = log.transactionIndex ?? 0;
                return txFromByHash.get(log.transactionHash as `0x${string}`) === victim
                    && (
                        approvalBlock < latestExploitOrder.blockNumber
                        || (approvalBlock === latestExploitOrder.blockNumber
                            && approvalTransactionIndex <= latestExploitOrder.transactionIndex)
                    );
            })
            .map((log) => ({
                blockNumber: Number(log.blockNumber ?? fromBlock),
                spender: getAddress(log.args.spender as `0x${string}`),
                token: getAddress(log.address),
                txFrom: txFromByHash.get(log.transactionHash as `0x${string}`)!,
                txHash: log.transactionHash as `0x${string}`,
                value: (log.args.value as bigint).toString(),
            }))
            .sort((a, b) => a.blockNumber - b.blockNumber || a.txHash.localeCompare(b.txHash));

        return disqualifiedApprovals.length > 0 ? [victim, disqualifiedApprovals] as const : null;
    });

    return Object.fromEntries(
        results.filter((result): result is readonly [`0x${string}`, DisqualifiedApproval[]] => result !== null),
    ) as DisqualifiedVictimReport;
}

export async function findVulnerableApprovals(
    client: Pick<Client, "call" | "request">,
    {
        fromBlock,
        spenders,
        tokens,
    }: {
        fromBlock: bigint;
        spenders: readonly `0x${string}`[];
        tokens: readonly `0x${string}`[];
    },
): Promise<VulnerableApprovalSummary> {
    const spenderTopics = spenders.map(addressToTopic);
    const tokenChunks = chunkItems(tokens, APPROVAL_LOG_TOKEN_CHUNK_SIZE);

    const approvalLogs = (
        await mapConcurrent(tokenChunks, APPROVAL_LOG_CONCURRENCY, async (tokenChunk) => {
            const logs = await client.request({
                method: "eth_getLogs",
                params: [
                    {
                        address: tokenChunk,
                        fromBlock: `0x${fromBlock.toString(16)}`,
                        topics: [APPROVAL_EVENT_TOPIC, null, spenderTopics],
                    },
                ],
            });

            return normalizeApprovalLogs(logs);
        })
    ).flat();

    const latestApprovals = collectLatestApprovalLogs(approvalLogs).filter((approval) => approval.value > 0n);
    const currentApprovals = (
        await mapConcurrent(latestApprovals, APPROVAL_READ_CONCURRENCY, async (approval) => {
            const currentAllowance = await readAllowance(client, approval.token, approval.owner, approval.spender);
            if (typeof currentAllowance === "undefined" || currentAllowance === 0n) {
                return null;
            }

            return {
                amount: currentAllowance,
                owner: approval.owner,
                spender: approval.spender,
                token: approval.token,
            };
        })
    ).filter((approval): approval is CurrentApproval => approval !== null);

    const currentBalanceByOwnerToken = await loadBalancesByOwnerToken(client, currentApprovals);
    return transposeVulnerableApprovals(currentApprovals, currentBalanceByOwnerToken);
}

export async function writeReports(
    incidentRows: IncidentRow[],
    summaries: VictimSummary,
    tokenSummaries: TokenLossSummary[],
    tokenMetadataByToken: ReadonlyMap<`0x${string}`, TokenMetadata>,
    disqualifiedVictims: DisqualifiedVictimReport,
    vulnerableApprovals: VulnerableApprovalSummary,
): Promise<string> {
    await mkdir(OUT_DIR, { recursive: true });
    await writeFile(path.join(OUT_DIR, "incident-rows.csv"), rowsToCsv(incidentRows));
    await writeFile(path.join(OUT_DIR, "summary-by-victim.json"), JSON.stringify(summaries, null, 2) + "\n");
    await writeFile(path.join(OUT_DIR, "summary-by-token.csv"), tokenSummariesToCsv(tokenSummaries, tokenMetadataByToken));
    await writeFile(path.join(OUT_DIR, "disqualified-victims.json"), JSON.stringify(disqualifiedVictims, null, 2) + "\n");
    await writeFile(path.join(OUT_DIR, "vulnerable-approvals.json"), JSON.stringify(vulnerableApprovals, null, 2) + "\n");
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

async function readAllowance(
    client: Pick<Client, "call">,
    token: `0x${string}`,
    owner: `0x${string}`,
    spender: `0x${string}`,
): Promise<bigint | undefined> {
    const data = await callToken(client, token, encodeFunctionData({
        abi: ALLOWANCE_ABI,
        functionName: "allowance",
        args: [owner, spender],
    }));

    return typeof data === "undefined" ? undefined : decodeUint256(data, ALLOWANCE_ABI);
}

async function readBalanceOf(
    client: Pick<Client, "call">,
    token: `0x${string}`,
    owner: `0x${string}`,
): Promise<bigint | undefined> {
    const data = await callToken(client, token, encodeFunctionData({
        abi: BALANCE_OF_ABI,
        functionName: "balanceOf",
        args: [owner],
    }));

    return typeof data === "undefined" ? undefined : decodeUint256(data, BALANCE_OF_ABI);
}

function decodeUint256(data: Hex, abi: typeof ALLOWANCE_ABI | typeof BALANCE_OF_ABI): bigint | undefined {
    try {
        const decoded = decodeFunctionResult({
            abi,
            data,
        });

        return typeof decoded === "bigint" ? decoded : BigInt(decoded);
    } catch {
        try {
            return hexToBigInt(data);
        } catch {
            return undefined;
        }
    }
}

async function loadBalancesByOwnerToken(
    client: Pick<Client, "call">,
    approvals: readonly CurrentApproval[],
): Promise<Map<string, bigint>> {
    const keys = [...new Set(approvals.map((approval) => ownerTokenKey(approval.owner, approval.token)))];
    const balances = new Map<string, bigint>();

    await mapConcurrent(keys, APPROVAL_READ_CONCURRENCY, async (key) => {
        const [owner, token] = splitOwnerTokenKey(key);
        const currentBalance = await readBalanceOf(client, token, owner);
        if (typeof currentBalance === "undefined") {
            console.warn(`Skipping vulnerable approval balance lookup for owner ${owner} token ${token}`);
            return;
        }

        balances.set(key, currentBalance);
    });

    return balances;
}

function transposeVulnerableApprovals(
    approvals: readonly CurrentApproval[],
    currentBalanceByOwnerToken: ReadonlyMap<string, bigint>,
): VulnerableApprovalSummary {
    const approvalsByRouter = new Map<`0x${string}`, Map<`0x${string}`, VulnerableApprovalEntry[]>>();

    for (const approval of approvals) {
        const currentBalance = currentBalanceByOwnerToken.get(ownerTokenKey(approval.owner, approval.token));
        if (typeof currentBalance === "undefined") {
            continue;
        }

        const effective = currentBalance < approval.amount ? currentBalance : approval.amount;
        let approvalsByToken = approvalsByRouter.get(approval.spender);
        if (!approvalsByToken) {
            approvalsByToken = new Map();
            approvalsByRouter.set(approval.spender, approvalsByToken);
        }

        const existing = approvalsByToken.get(approval.token);
        const entry = {
            amount: formatApprovalAmount(approval.amount),
            effective: formatApprovalAmount(effective),
            owner: approval.owner,
        };

        if (existing) {
            existing.push(entry);
        } else {
            approvalsByToken.set(approval.token, [entry]);
        }
    }

    return Object.fromEntries(
        [...approvalsByRouter.entries()]
            .sort(([routerA], [routerB]) => compareStrings(routerA, routerB))
            .map(([router, approvalsByToken]) => [
                router,
                Object.fromEntries(
                    [...approvalsByToken.entries()]
                        .sort(([tokenA], [tokenB]) => compareStrings(tokenA, tokenB))
                        .map(([token, approvals]) => [
                            token,
                            approvals.sort((approvalA, approvalB) => compareStrings(approvalA.owner, approvalB.owner)),
                        ]),
                ) as VulnerableApprovalByToken,
            ]),
    ) as VulnerableApprovalSummary;
}

function collectLatestApprovalLogs(logs: readonly ApprovalLog[]): ApprovalLog[] {
    const latestByApproval = new Map<string, ApprovalLog>();

    for (const log of [...logs].sort(compareApprovalLogs)) {
        latestByApproval.set(approvalKey(log.owner, log.token, log.spender), log);
    }

    return [...latestByApproval.values()].sort(compareApprovalLogs);
}

function normalizeApprovalLogs(value: unknown): ApprovalLog[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value.flatMap((entry) => {
        const log = normalizeApprovalLog(entry);
        return log ? [log] : [];
    });
}

function normalizeApprovalLog(value: unknown): ApprovalLog | null {
    if (!value || typeof value !== "object") {
        return null;
    }

    const maybeLog = value as Partial<RawRpcLog>;
    if (
        typeof maybeLog.address !== "string"
        || typeof maybeLog.data !== "string"
        || !Array.isArray(maybeLog.topics)
        || maybeLog.topics.length < 3
        || maybeLog.topics[0].toLowerCase() !== APPROVAL_EVENT_TOPIC.toLowerCase()
        || maybeLog.removed === true
    ) {
        return null;
    }

    try {
        return {
            blockNumber: Number(hexToBigInt(maybeLog.blockNumber ?? "0x0")),
            logIndex: Number(hexToBigInt(maybeLog.logIndex ?? "0x0")),
            owner: topicToAddress(maybeLog.topics[1]),
            spender: topicToAddress(maybeLog.topics[2]),
            token: getAddress(maybeLog.address),
            transactionIndex: Number(hexToBigInt(maybeLog.transactionIndex ?? "0x0")),
            value: hexToBigInt(maybeLog.data),
        };
    } catch {
        return null;
    }
}

function chunkItems<T>(items: readonly T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let index = 0; index < items.length; index += size) {
        chunks.push(items.slice(index, index + size));
    }

    return chunks;
}

function addressToTopic(address: `0x${string}`): Hex {
    return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}

function topicToAddress(topic: Hex): `0x${string}` {
    return getAddress(`0x${topic.slice(-40)}`);
}

function approvalKey(
    owner: `0x${string}`,
    token: `0x${string}`,
    spender: `0x${string}`,
): string {
    return `${owner.toLowerCase()}:${token.toLowerCase()}:${spender.toLowerCase()}`;
}

function ownerTokenKey(owner: `0x${string}`, token: `0x${string}`): string {
    return `${owner.toLowerCase()}:${token.toLowerCase()}`;
}

function splitOwnerTokenKey(key: string): [`0x${string}`, `0x${string}`] {
    const [owner, token] = key.split(":");
    return [getAddress(owner), getAddress(token)];
}

function compareApprovalLogs(a: ApprovalLog, b: ApprovalLog): number {
    return a.blockNumber - b.blockNumber
        || a.transactionIndex - b.transactionIndex
        || a.logIndex - b.logIndex
        || compareStrings(a.token, b.token)
        || compareStrings(a.owner, b.owner)
        || compareStrings(a.spender, b.spender);
}

function compareStrings(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

function formatApprovalAmount(amount: bigint): string {
    return amount >= MAX_UINT256 ? "infinite" : amount.toString();
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
