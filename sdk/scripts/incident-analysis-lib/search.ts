import {
    bytesToHex,
    getAddress,
    hexToBigInt,
    hexToBytes,
    zeroAddress,
} from "viem";
import type { Hex, PublicClient } from "viem";
import { ADDRESS_BYTES, decodeHuffRouterCalldata } from "../huffrouter-calldata.ts";
import { Client } from "./io.ts";
import { inspect } from "node:util";

const TRACE_FILTER_COUNT = 100_000;
export const TRACE_CONCURRENCY = 8;
export const IGNORED_TRANSACTIONS: readonly `0x${string}`[] = [
    "0x7b818b4a00c182ad2fb5e383b4c1664012cf8a274bec1506dbc28dfcc2e97733", // Seems like the HuffRouter was called with Solidity router args
    "0x812a3bad2805776bf4f601ec15963eb136829ca76ba5f3daaf568e3cad94a57b", // Just wrong calldata
    "0xb719245c14b2a609e0b4bf2223aae7025b49722ddf12c1bf1b976cbe436ff5a4", // Same as above
    "0xccac5c6a1618202eb23c6b092f9d04744767e39063f37062f4991a23a17ca928", // Tries to execute via a one-hop swap but fails due to both the victim and Core not having the required WBTC amounts
    "0xe79f0bd4bfb4483c4b3b118cd2cf1a66947799688f2a89af037ea54887cf40d8", // No-op swap
    "0xf589463f87e1b7c5b95c4ac21fedd614675f159dc409d5a8e72b5c5509968fa3", // Same as above
    "0x5cd6791559c242c63f6c8576f8f059c0b3df9a8fa61b7123e07de4699fb5e8ce", // Slippage check fail
    "0x74523d25ec6fd516518ed918a842874a96c57133e2c9bf69c90c1c6f5ff369dc", // Slippage check fail
    "0x6929cd83a98ac9f94454b04fd20955dc5af64063b6e014d099103c118541ab7d", // White-hat rescue attempt, fails twice with "bad jump destination" (intentional, since hop type is out-of-bounds (196))
    "0xe67198cf4991eccb28ee430b6d4b21f929bb9193c164ff04061fb9baad0323df", // Also "bad jump destination", calldata only 8 bytes long
    "0x401cc36f3ffdab4f9d3973700debcac614d5dea87dd9b520d60abc0c3e2033bc", // Tries to exploit SKL approvals which neither Core nor the victim owns
    "0xebed608c462dbdc78e4b7324e19cc7558e36a9dd83a181ab628f2c35654d20fa", // Runs out-of-gas inside the lock
];
const IGNORED_TRANSACTION_SET = new Set(IGNORED_TRANSACTIONS.map((txHash) => txHash.toLowerCase()));

export const V2_CORE_ADDRESS = getAddress("0xe0e0e08a6a4b9dc7bd67bcb7aade5cf48157d444");
export const V3_CORE_ADDRESS = getAddress("0x00000000000014aa86c5d3c41765bb24e11bd701");
export const TRANSFER_EVENT_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export type RouterGeneration = "V2" | "V3";

export interface AffectedDeployments {
    deployments: AffectedDeployment[];
    startBlock: bigint;
}

export interface AffectedDeployment {
    core: `0x${string}`;
    router: `0x${string}`;
    routerGeneration: RouterGeneration;
    tokenList: readonly `0x${string}`[];
}

export interface TraceAction {
    callType: string;
    from: `0x${string}`;
    gas: Hex;
    input: Hex;
    to: `0x${string}`;
    value: Hex;
}

export interface TraceResult {
    gasUsed: Hex;
    output: Hex;
}

export interface TransactionTrace {
    action: TraceAction;
    blockHash: Hex;
    blockNumber: number;
    error?: string;
    result: TraceResult;
    subtraces: number;
    traceAddress: number[];
    transactionHash: `0x${string}`;
    transactionPosition: number;
    type: string;
}

export interface TransactionLog {
    address: `0x${string}`;
    data: Hex;
    logIndex?: number | string | null;
    topics: Hex[];
}

export interface WrappedTransactionTrace {
    name?: string;
    value?: unknown;
}

export interface ApprovalDrainExploitMatch {
    amount: bigint;
    attackerToken: Hex;
    attacker: `0x${string}`;
    victimToken: `0x${string}`;
    victim: `0x${string}`;
}

export interface PotentialExploitTrace {
    match: ApprovalDrainExploitMatch;
    trace: TransactionTrace;
}

export interface IncidentRow {
    blockNumber: number;
    rawAmount: string;
    router: `0x${string}`;
    routerCaller: `0x${string}`;
    routerGeneration: RouterGeneration;
    victimToken: Hex;
    attackerToken: Hex;
    traceAddress: string;
    transactionIndex?: number;
    txFrom: `0x${string}`;
    txHash: `0x${string}`;
    victim: `0x${string}`;
}

export interface VictimLossEntry {
    amount: string;
    token: `0x${string}`;
}

export type VictimSummary = Partial<Record<`0x${string}`, VictimLossEntry[]>>;

export interface TokenLossSummary {
    amount: string;
    token: `0x${string}`;
}

interface ParsedTransferLog {
    amount: bigint;
    from: `0x${string}`;
    logIndex: number;
    token: `0x${string}`;
    to: `0x${string}`;
}

interface CreditTransferLog extends ParsedTransferLog {
    remainingAmount: bigint;
}

interface MatchedExploitTrace {
    deployment: AffectedDeployment;
    payLog: ParsedTransferLog;
    potentialExploitTrace: PotentialExploitTrace;
}

export async function findPotentialExploitTraces(
    client: Client,
    affectedDeployments: AffectedDeployments,
): Promise<PotentialExploitTrace[]> {
    const deploymentByRouter = new Map(affectedDeployments.deployments.map((deployment) => [deployment.router, deployment]));
    const traces = normalizeTransactionTraces(await client.request({
        method: "trace_filter",
        params: [
            {
                count: TRACE_FILTER_COUNT,
                fromBlock: `0x${affectedDeployments.startBlock.toString(16)}`,
                toAddress: affectedDeployments.deployments.map((deployment) => deployment.router),
            },
        ],
    }));

    if (traces.length === TRACE_FILTER_COUNT) {
        throw new Error(
            `trace_filter reached the configured count limit (${TRACE_FILTER_COUNT}); single-call scan may be truncated`,
        );
    }

    return traces.flatMap((trace) => {
        if (IGNORED_TRANSACTION_SET.has(trace.transactionHash.toLowerCase())) {
            return [];
        }

        if (trace.type !== "call") {
            return [];
        }

        const router = getAddress(trace.action.to);
        const deployment = deploymentByRouter.get(router);
        if (!deployment || getAddress(trace.action.from) === deployment.core) {
            return [];
        }

        let match;
        try {
            match = matchPotentialExploitTraceInput(trace.action.input, deployment.tokenList);
        } catch(err) {
            console.error(`Transaction ${trace.transactionHash}:`, err);
            return [];
        }

        if (match === null) {
            return [];
        }

        return [{ match, trace }];
    });
}

function matchPotentialExploitTraceInput(
    hex: Hex,
    tokenList: readonly `0x${string}`[],
): ApprovalDrainExploitMatch | null {
    const decoded = decodeHuffRouterCalldata(hex, tokenList, { allowTrailingBytes: true });

    if (!decoded.trailingCalldata) {
        return null;
    }

    const trailingBytes = hexToBytes(decoded.trailingCalldata);

    let unknownParameterization = trailingBytes.length < 52
        || decoded.withRecipient
        || decoded.withIntegrationFee
        || decoded.isExactOut
        || decoded.multiHops.length !== 1;

    if (unknownParameterization) {
        throw new Error(`Unknown trailing calldata parameterization: ${inspect(decoded, {depth: null})}`);
    }

    return {
        amount: decoded.multiHops[0].specifiedAmount,
        attackerToken: decoded.calculatedToken,
        attacker: getAddress(bytesToHex(trailingBytes.slice(0, ADDRESS_BYTES))),
        victimToken: decoded.specifiedToken,
        victim: getAddress(bytesToHex(trailingBytes.slice(32, 52))),
    };
}

export function findExploitIncidents({
    deployments,
    logs,
    potentialExploitTraces,
    txFrom,
}: {
    deployments: AffectedDeployment[];
    logs: TransactionLog[];
    potentialExploitTraces: PotentialExploitTrace[];
    txFrom: `0x${string}`;
}): IncidentRow[] {
    const deploymentByRouter = new Map(deployments.map((deployment) => [deployment.router, deployment]));
    const rows: IncidentRow[] = [];
    const parsedTransferLogs = logs
        .map((log, index) => parseTransferLog(log, index))
        .filter((log): log is ParsedTransferLog => log !== null)
        .sort((a, b) => a.logIndex - b.logIndex);
    const availableTransferLogs = [...parsedTransferLogs];
    const matchedTransferLogIndexes = new Set<number>();
    const matchedExploitTraces: MatchedExploitTrace[] = [];
    const sortedPotentialExploitTraces = [...potentialExploitTraces].sort((a, b) => {
        return a.trace.blockNumber - b.trace.blockNumber
            || compareStrings(a.trace.transactionHash, b.trace.transactionHash)
            || compareStrings(traceAddressToString(a.trace.traceAddress), traceAddressToString(b.trace.traceAddress));
    });

    for (const potentialExploitTrace of sortedPotentialExploitTraces) {
        const deployment = deploymentByRouter.get(getAddress(potentialExploitTrace.trace.action.to));
        if (!deployment) {
            throw new Error(
                `no deployment metadata for tx ${potentialExploitTrace.trace.transactionHash} router ${potentialExploitTrace.trace.action.to}`,
            );
        }

        const { amount, attacker, victimToken, attackerToken, victim } = potentialExploitTrace.match;
        if (attackerToken === zeroAddress) {
            console.warn("Skipping attacker receival check due to native token");
        } else {
            const withdrawIndex = availableTransferLogs.findIndex((log) => {
                return log.token === attackerToken
                    && log.from === deployment.core
                    && log.to === attacker
                    && log.amount === amount;
            });
            if (withdrawIndex === -1) {
                throw new Error(
                    `could not match Core -> attacker transfer for tx ${potentialExploitTrace.trace.transactionHash} trace ${traceAddressToString(potentialExploitTrace.trace.traceAddress)}`,
                );
            }
            const [withdrawLog] = availableTransferLogs.splice(withdrawIndex, 1);
            matchedTransferLogIndexes.add(withdrawLog.logIndex);
        }


        const payIndex = availableTransferLogs.findIndex((log) => {
            return log.token === victimToken
                && log.from === victim
                && log.to === deployment.core
                && log.amount === amount;
        });
        if (payIndex === -1) {
            throw new Error(
                `could not match victim -> Core transfer for tx ${potentialExploitTrace.trace.transactionHash} trace ${traceAddressToString(potentialExploitTrace.trace.traceAddress)}`,
            );
        }
        const [payLog] = availableTransferLogs.splice(payIndex, 1);
        matchedTransferLogIndexes.add(payLog.logIndex);

        matchedExploitTraces.push({
            deployment,
            payLog,
            potentialExploitTrace,
        });
    }

    const availableCreditLogs: CreditTransferLog[] = parsedTransferLogs
        .filter((log) => !matchedTransferLogIndexes.has(log.logIndex))
        .map((log) => ({ ...log, remainingAmount: log.amount }));

    matchedExploitTraces.sort((a, b) => {
        return a.payLog.logIndex - b.payLog.logIndex
            || compareStrings(traceAddressToString(a.potentialExploitTrace.trace.traceAddress), traceAddressToString(b.potentialExploitTrace.trace.traceAddress));
    });

    for (const matchedExploitTrace of matchedExploitTraces) {
        const { deployment, payLog, potentialExploitTrace } = matchedExploitTrace;
        const { amount, victimToken, attackerToken, victim } = potentialExploitTrace.match;
        let netLoss = amount;

        for (const creditLog of availableCreditLogs) {
            if (
                creditLog.remainingAmount === 0n
                || creditLog.token !== victimToken
                || creditLog.to !== victim
                || creditLog.logIndex >= payLog.logIndex
            ) {
                continue;
            }

            const offsetAmount = creditLog.remainingAmount < netLoss ? creditLog.remainingAmount : netLoss;
            creditLog.remainingAmount -= offsetAmount;
            netLoss -= offsetAmount;

            if (netLoss === 0n) {
                break;
            }
        }

        if (netLoss === 0n) {
            continue;
        }

        rows.push({
            blockNumber: potentialExploitTrace.trace.blockNumber,
            rawAmount: netLoss.toString(),
            router: deployment.router,
            routerCaller: getAddress(potentialExploitTrace.trace.action.from),
            routerGeneration: deployment.routerGeneration,
            victimToken,
            attackerToken,
            traceAddress: traceAddressToString(potentialExploitTrace.trace.traceAddress),
            txFrom: getAddress(txFrom),
            txHash: potentialExploitTrace.trace.transactionHash,
            victim,
        });
    }

    rows.sort(compareIncidentRows);
    return rows;
}

export function summarizeVictimLosses(rows: IncidentRow[]): VictimSummary {
    const summaries = new Map<`0x${string}`, Map<`0x${string}`, bigint>>();

    for (const row of rows) {
        let tokenSummaries = summaries.get(row.victim);
        if (!tokenSummaries) {
            tokenSummaries = new Map();
            summaries.set(row.victim, tokenSummaries);
        }

        tokenSummaries.set(
            row.victimToken,
            (tokenSummaries.get(row.victimToken) ?? 0n) + BigInt(row.rawAmount),
        );
    }

    return Object.fromEntries(
        [...summaries.entries()]
            .sort(([victimA], [victimB]) => compareStrings(victimA, victimB))
            .map(([victim, tokenSummaries]) => [
                victim,
                [...tokenSummaries.entries()]
                    .sort(([tokenA], [tokenB]) => compareStrings(tokenA, tokenB))
                    .map(([token, amount]) => ({
                        amount: amount.toString(),
                        token,
                    })),
            ]),
    ) as VictimSummary;
}

export function summarizeTokenLosses(rows: IncidentRow[]): TokenLossSummary[] {
    const summaries = new Map<`0x${string}`, bigint>();

    for (const row of rows) {
        summaries.set(row.victimToken, (summaries.get(row.victimToken) ?? 0n) + BigInt(row.rawAmount));
    }

    return [...summaries.entries()]
        .sort(([tokenA], [tokenB]) => compareStrings(tokenA, tokenB))
        .map(([token, amount]) => ({
            amount: amount.toString(),
            token,
        }));
}

export function isIgnoredTransaction(txHash: string): boolean {
    return IGNORED_TRANSACTION_SET.has(txHash.toLowerCase());
}

export async function mapConcurrent<T, R>(
    items: readonly T[],
    concurrency: number,
    mapper: (item: T) => Promise<R>,
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let nextIndex = 0;

    async function worker() {
        while (true) {
            const currentIndex = nextIndex++;
            if (currentIndex >= items.length) {
                return;
            }

            results[currentIndex] = await mapper(items[currentIndex]);
        }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
    return results;
}

export async function analyzeTransaction(
    client: Client,
    deployments: AffectedDeployment[],
    potentialExploitTraces: PotentialExploitTrace[],
    txHash: Hex,
): Promise<IncidentRow[]> {
    const receipt = await client.getTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
        return [];
    }

    return findExploitIncidents({
        deployments,
        logs: receipt.logs as TransactionLog[],
        potentialExploitTraces,
        txFrom: getAddress(receipt.from),
    }).map((row) => ({
        ...row,
        transactionIndex: receipt.transactionIndex,
    }));
}

function parseTransferLog(log: TransactionLog, fallbackIndex: number): ParsedTransferLog | null {
    if (log.topics.length !== 3 || log.topics[0].toLowerCase() !== TRANSFER_EVENT_TOPIC) {
        return null;
    }

    try {
        return {
            amount: hexToBigInt(log.data),
            from: topicToAddress(log.topics[1]),
            logIndex: parseOptionalNumericField(log.logIndex) ?? fallbackIndex,
            token: getAddress(log.address),
            to: topicToAddress(log.topics[2]),
        };
    } catch {
        return null;
    }
}

function topicToAddress(topic: Hex): `0x${string}` {
    return getAddress(`0x${topic.slice(-40)}`);
}

export function normalizeTransactionTraces(value: unknown): TransactionTrace[] {
    if (Array.isArray(value)) {
        return value.flatMap((entry) => {
            const trace = normalizeTransactionTrace(unwrapTransactionTrace(entry));
            return trace ? [trace] : [];
        });
    }

    if (value && typeof value === "object" && "result" in value) {
        return normalizeTransactionTraces((value as { result?: unknown }).result);
    }

    return [];
}

export function traceAddressToString(traceAddress: number[]): string {
    return traceAddress.join("/");
}

function unwrapTransactionTrace(value: unknown): unknown {
    if (!value || typeof value !== "object") {
        return null;
    }

    if ("value" in value) {
        return unwrapTransactionTrace((value as WrappedTransactionTrace).value);
    }

    return value;
}

function normalizeTransactionTrace(value: unknown): TransactionTrace | null {
    if (!value || typeof value !== "object") {
        return null;
    }

    const maybeTrace = value as Partial<TransactionTrace>;
    const action = normalizeTraceAction(maybeTrace.action);
    const result = normalizeTraceResult(maybeTrace.result);
    const blockHash = typeof maybeTrace.blockHash === "string" ? maybeTrace.blockHash as Hex : null;
    const blockNumber = parseNumericField(maybeTrace.blockNumber);
    const subtraces = parseNumericField(maybeTrace.subtraces);
    const traceAddress = normalizeTraceAddress(maybeTrace.traceAddress);
    const transactionHash = typeof maybeTrace.transactionHash === "string" ? maybeTrace.transactionHash as `0x${string}` : null;
    const transactionPosition = parseNumericField(maybeTrace.transactionPosition);
    const type = typeof maybeTrace.type === "string" ? maybeTrace.type : null;

    if (!action || !result || !blockHash || blockNumber === null || subtraces === null || !traceAddress || !transactionHash || transactionPosition === null || !type) {
        return null;
    }

    return {
        action,
        blockHash,
        blockNumber,
        ...(typeof maybeTrace.error === "string" ? { error: maybeTrace.error } : {}),
        result,
        subtraces,
        traceAddress,
        transactionHash,
        transactionPosition,
        type,
    };
}

function normalizeTraceAction(value: unknown): TraceAction | null {
    if (!value || typeof value !== "object") {
        return null;
    }

    const maybeAction = value as Partial<TraceAction>;
    if (
        typeof maybeAction.callType !== "string"
        || typeof maybeAction.from !== "string"
        || typeof maybeAction.gas !== "string"
        || typeof maybeAction.input !== "string"
        || typeof maybeAction.to !== "string"
        || typeof maybeAction.value !== "string"
    ) {
        return null;
    }

    return {
        callType: maybeAction.callType,
        from: maybeAction.from,
        gas: maybeAction.gas as Hex,
        input: maybeAction.input as Hex,
        to: maybeAction.to,
        value: maybeAction.value as Hex,
    };
}

function normalizeTraceResult(value: unknown): TraceResult | null {
    if (!value || typeof value !== "object") {
        return null;
    }

    const maybeResult = value as Partial<TraceResult>;
    if (typeof maybeResult.gasUsed !== "string" || typeof maybeResult.output !== "string") {
        return null;
    }

    return {
        gasUsed: maybeResult.gasUsed as Hex,
        output: maybeResult.output as Hex,
    };
}

function normalizeTraceAddress(value: unknown): number[] | null {
    if (!Array.isArray(value)) {
        return null;
    }

    const normalized = value.map(parseNumericField);
    return normalized.every((segment) => segment !== null) ? normalized as number[] : null;
}

function parseNumericField(value: unknown): number | null {
    if (typeof value === "number") {
        return Number.isInteger(value) ? value : null;
    }

    if (typeof value !== "string") {
        return null;
    }

    const parsed = value.startsWith("0x")
        ? Number.parseInt(value.slice(2), 16)
        : Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
}

function parseOptionalNumericField(value: unknown): number | null {
    if (typeof value === "undefined" || value === null) {
        return null;
    }

    return parseNumericField(value);
}

function compareIncidentRows(a: IncidentRow, b: IncidentRow): number {
    return a.blockNumber - b.blockNumber
        || (a.transactionIndex ?? 0) - (b.transactionIndex ?? 0)
        || compareStrings(a.txHash, b.txHash)
        || compareStrings(a.traceAddress, b.traceAddress);
}

function compareStrings(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}
