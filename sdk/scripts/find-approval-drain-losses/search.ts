import {
    bytesToHex,
    getAddress,
    hexToBigInt,
    hexToBytes,
} from "viem";
import type { Hex } from "viem";
import { ADDRESS_BYTES, decodeHyperRouterCalldata } from "../hyperrouter-calldata.ts";

const TRACE_FILTER_COUNT = 100_000;
export const TRACE_CONCURRENCY = 8;
export const IGNORED_TRANSACTIONS: readonly `0x${string}`[] = [
    "0x401cc36f3ffdab4f9d3973700debcac614d5dea87dd9b520d60abc0c3e2033bc", // Tries to exploit SKL approvals which neither Core nor the victim owns
    "0xebed608c462dbdc78e4b7324e19cc7558e36a9dd83a181ab628f2c35654d20fa", // Runs out-of-gas inside the lock
];
const IGNORED_TRANSACTION_SET = new Set(IGNORED_TRANSACTIONS.map((txHash) => txHash.toLowerCase()));

export const V2_CORE_ADDRESS = getAddress("0xe0e0e08a6a4b9dc7bd67bcb7aade5cf48157d444");
export const V3_CORE_ADDRESS = getAddress("0x00000000000014aa86c5d3c41765bb24e11bd701");
export const TRANSFER_EVENT_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

interface Client {
    getTransactionReceipt(args: { hash: Hex }): Promise<{
        from: `0x${string}`;
        logs: unknown[];
        status: string;
    }>;
    request(args: {
        method: "trace_filter";
        params: unknown[];
    }): Promise<unknown>;
}

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
    attacker: `0x${string}`;
    token: `0x${string}`;
    victim: `0x${string}`;
}

export interface PotentialExploitTrace {
    match: ApprovalDrainExploitMatch;
    trace: TransactionTrace;
}

export interface IncidentRow {
    blockNumber: number;
    chainId: number;
    rawAmount: string;
    router: `0x${string}`;
    routerCaller: `0x${string}`;
    routerGeneration: RouterGeneration;
    token: `0x${string}`;
    traceAddress: string;
    txFrom: `0x${string}`;
    txHash: `0x${string}`;
    victim: `0x${string}`;
}

export interface IncidentRowWithMetadata extends IncidentRow {
    tokenDecimals?: number;
    tokenSymbol?: string;
}

export interface VictimSummary {
    chainId: number;
    exploitRowCount: number;
    rawAmountTotal: string;
    routerCallers: `0x${string}`[];
    token: `0x${string}`;
    tokenDecimals?: number;
    tokenSymbol?: string;
    txHashes: `0x${string}`[];
    victim: `0x${string}`;
}

export interface TokenMetadata {
    decimals?: number;
    symbol?: string;
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
    withdrawLog: ParsedTransferLog;
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

export function findExploitIncidents({
    chainId,
    deployments,
    logs,
    potentialExploitTraces,
    txFrom,
}: {
    chainId: bigint;
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

        const { amount, attacker, token, victim } = potentialExploitTrace.match;
        const withdrawIndex = availableTransferLogs.findIndex((log) => {
            return log.token === token
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

        const payIndex = availableTransferLogs.findIndex((log) => {
            return log.token === token
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
            withdrawLog,
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
        const { amount, token, victim } = potentialExploitTrace.match;
        let netLoss = amount;

        for (const creditLog of availableCreditLogs) {
            if (
                creditLog.remainingAmount === 0n
                || creditLog.token !== token
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
            chainId: Number(chainId),
            rawAmount: netLoss.toString(),
            router: deployment.router,
            routerCaller: getAddress(potentialExploitTrace.trace.action.from),
            routerGeneration: deployment.routerGeneration,
            token,
            traceAddress: traceAddressToString(potentialExploitTrace.trace.traceAddress),
            txFrom: getAddress(txFrom),
            txHash: potentialExploitTrace.trace.transactionHash,
            victim,
        });
    }

    rows.sort(compareIncidentRows);
    return rows;
}

export function summarizeVictimLosses(rows: IncidentRowWithMetadata[]): VictimSummary[] {
    const summaries = new Map<string, VictimSummary>();

    for (const row of rows) {
        const key = `${row.chainId}:${row.victim}:${row.token}`;
        const existing = summaries.get(key);

        if (!existing) {
            summaries.set(key, {
                chainId: row.chainId,
                exploitRowCount: 1,
                rawAmountTotal: row.rawAmount,
                routerCallers: [row.routerCaller],
                token: row.token,
                tokenDecimals: row.tokenDecimals,
                tokenSymbol: row.tokenSymbol,
                txHashes: [row.txHash],
                victim: row.victim,
            });
            continue;
        }

        existing.exploitRowCount += 1;
        existing.rawAmountTotal = (BigInt(existing.rawAmountTotal) + BigInt(row.rawAmount)).toString();

        if (!existing.txHashes.includes(row.txHash)) {
            existing.txHashes.push(row.txHash);
            existing.txHashes.sort();
        }

        if (!existing.routerCallers.includes(row.routerCaller)) {
            existing.routerCallers.push(row.routerCaller);
            existing.routerCallers.sort();
        }

        if (typeof existing.tokenSymbol === "undefined" && typeof row.tokenSymbol !== "undefined") {
            existing.tokenSymbol = row.tokenSymbol;
        }

        if (typeof existing.tokenDecimals === "undefined" && typeof row.tokenDecimals !== "undefined") {
            existing.tokenDecimals = row.tokenDecimals;
        }
    }

    return [...summaries.values()].sort((a, b) => {
        return a.chainId - b.chainId
            || compareStrings(a.victim, b.victim)
            || compareStrings(a.token, b.token);
    });
}

export function enrichRowsWithTokenMetadata(
    rows: IncidentRow[],
    metadataByTokenKey: ReadonlyMap<string, TokenMetadata>,
): IncidentRowWithMetadata[] {
    return rows.map((row) => {
        const metadata = metadataByTokenKey.get(tokenKey(row.chainId, row.token));

        return {
            ...row,
            ...(metadata?.symbol ? { tokenSymbol: metadata.symbol } : {}),
            ...(typeof metadata?.decimals === "number" ? { tokenDecimals: metadata.decimals } : {}),
        };
    });
}

export function tokenKey(chainId: bigint | number, token: `0x${string}`): string {
    return `${chainId}:${token}`;
}

export function isIgnoredTransaction(txHash: string): boolean {
    return IGNORED_TRANSACTION_SET.has(txHash.toLowerCase());
}

function matchPotentialExploitTraceInput(
    hex: Hex,
    chainId: bigint,
    tokenList: readonly `0x${string}`[],
): ApprovalDrainExploitMatch | null {
    let decoded;
    try {
        decoded = decodeHyperRouterCalldata(hex, chainId, { allowTrailingBytes: true, tokenList });
    } catch {
        return null;
    }

    if (
        decoded.withRecipient
        || decoded.withIntegrationFee
        || decoded.isExactOut
        || decoded.specifiedTokenInfo !== decoded.calculatedTokenInfo
        || decoded.specifiedToken !== decoded.calculatedToken
        || decoded.multiHops.length !== 1
        || !decoded.trailingCalldata
    ) {
        return null;
    }

    const [multiHop] = decoded.multiHops;
    if (multiHop.hops.length !== 1 || multiHop.specifiedAmount <= 0n) {
        return null;
    }

    const [hop] = multiHop.hops;
    if (
        hop.type !== "wrappedToken"
        || hop.callType !== "unwrap"
        || hop.underlying !== hop.wrapped
        || hop.wrapped !== decoded.specifiedToken
    ) {
        return null;
    }

    const trailingBytes = hexToBytes(decoded.trailingCalldata);
    if (trailingBytes.length < 52) {
        return null;
    }

    return {
        amount: multiHop.specifiedAmount,
        attacker: getAddress(bytesToHex(trailingBytes.slice(0, ADDRESS_BYTES))),
        token: decoded.specifiedToken,
        victim: getAddress(bytesToHex(trailingBytes.slice(32, 52))),
    };
}

export async function findPotentialExploitTraces(
    client: Client,
    chainId: bigint,
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
        if (trace.type !== "call") {
            return [];
        }

        const router = getAddress(trace.action.to);
        const deployment = deploymentByRouter.get(router);
        if (!deployment || getAddress(trace.action.from) === deployment.core) {
            return [];
        }

        const match = matchPotentialExploitTraceInput(trace.action.input, chainId, deployment.tokenList);
        if (!match) {
            return [];
        }

        return [{ match, trace }];
    });
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
    chainId: bigint,
    deployments: AffectedDeployment[],
    potentialExploitTraces: PotentialExploitTrace[],
    txHash: Hex,
): Promise<IncidentRow[]> {
    const receipt = await client.getTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
        return [];
    }

    return findExploitIncidents({
        chainId,
        deployments,
        logs: receipt.logs as TransactionLog[],
        potentialExploitTraces,
        txFrom: getAddress(receipt.from),
    });
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
    return a.chainId - b.chainId
        || a.blockNumber - b.blockNumber
        || compareStrings(a.txHash, b.txHash)
        || compareStrings(a.traceAddress, b.traceAddress);
}

function compareStrings(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}
