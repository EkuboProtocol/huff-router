import { describe, expect, test, vi } from "vitest";
import { encodeFunctionData, getAddress, parseAbi } from "viem";
import type { Hex } from "viem";
import {
    findExploitIncidents,
    summarizeTokenLosses,
    summarizeVictimLosses,
    V2_CORE_ADDRESS,
    V3_CORE_ADDRESS,
} from "../scripts/incident-analysis-lib/search.ts";
import type {
    AffectedDeployment,
    IncidentRow,
    PotentialExploitTrace,
    TransactionLog,
    TransactionTrace,
} from "../scripts/incident-analysis-lib/search.ts";
import { findVulnerableApprovals } from "../scripts/incident-analysis-lib/io.ts";
import type { Client } from "../scripts/incident-analysis-lib/io.ts";

const TEST_BLOCK_HASH = `0x${"1".repeat(64)}` as Hex;
const TEST_GAS = "0x0" as Hex;
const TEST_RESULT = {
    gasUsed: "0x0" as Hex,
    output: "0x" as Hex,
};
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as Hex;
const V3_ROUTER = getAddress("0x4f168f17923435c999f5c8565acab52c2218edf2");
const V2_ROUTER = getAddress("0x8f52903d17e2d8d6c77d1a1de0cc975b6b5a0d15");
const ATTACKER = getAddress("0xa911ff351b143634dbc5af3e204ea074583a83e3");
const VICTIM = getAddress("0x765decf4fa157756e850c1079f60801b9219edd1");
const TOKEN = getAddress("0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599");
const FLASH_LENDER = getAddress("0x130dDDD151A00f05A9F8d8d0D52fA3f58a884321");
const OTHER_BOT = getAddress("0x11AB8a601Bd3C42CdDAA57cD15e16ca3963Aa015");
const V2_ROUTER_ALT = getAddress("0x8ccb1ffd5c2aa6bd926473425dea4c8c15de60fd");
const ALLOWANCE_ABI = parseAbi(["function allowance(address owner, address spender) view returns (uint256)"]);
const BALANCE_OF_ABI = parseAbi(["function balanceOf(address owner) view returns (uint256)"]);
const APPROVAL_TOPIC = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925" as Hex;
const MAX_UINT256 = (1n << 256n) - 1n;

const DEPLOYMENTS: AffectedDeployment[] = [
    {
        core: V2_CORE_ADDRESS,
        router: V2_ROUTER,
        routerGeneration: "V2",
        tokenList: [],
    },
    {
        core: V3_CORE_ADDRESS,
        router: V3_ROUTER,
        routerGeneration: "V3",
        tokenList: [],
    },
];

function makeTrace({
    blockNumber,
    router,
    routerCaller,
    traceAddress,
    txHash,
}: {
    blockNumber: number;
    router: `0x${string}`;
    routerCaller: `0x${string}`;
    traceAddress: number[];
    txHash: `0x${string}`;
}): TransactionTrace {
    return {
        action: {
            callType: "call",
            from: routerCaller,
            gas: TEST_GAS,
            input: "0x" as Hex,
            to: router,
            value: "0x0" as Hex,
        },
        blockHash: TEST_BLOCK_HASH,
        blockNumber,
        result: TEST_RESULT,
        subtraces: 0,
        traceAddress,
        transactionHash: txHash,
        transactionPosition: 0,
        type: "call",
    };
}

function makeTransferLog({
    amount,
    from,
    logIndex,
    to,
    token,
}: {
    amount: bigint;
    from: `0x${string}`;
    logIndex: number;
    to: `0x${string}`;
    token: `0x${string}`;
}): TransactionLog {
    return {
        address: token,
        data: `0x${amount.toString(16).padStart(64, "0")}` as Hex,
        logIndex,
        topics: [
            TRANSFER_TOPIC,
            `0x${"0".repeat(24)}${from.slice(2).toLowerCase()}` as Hex,
            `0x${"0".repeat(24)}${to.slice(2).toLowerCase()}` as Hex,
        ],
    };
}

function makeExploitMatch(amount: bigint) {
    return {
        amount,
        attacker: ATTACKER,
        attackerToken: TOKEN,
        victim: VICTIM,
        victimToken: TOKEN,
    } as const;
}

function makeApprovalLog({
    blockNumber,
    logIndex,
    owner,
    spender,
    token,
    transactionIndex = 0,
    value,
}: {
    blockNumber: number;
    logIndex: number;
    owner: `0x${string}`;
    spender: `0x${string}`;
    token: `0x${string}`;
    transactionIndex?: number;
    value: bigint;
}) {
    return {
        address: token,
        blockNumber: `0x${blockNumber.toString(16)}`,
        data: encodeUint256(value),
        logIndex: `0x${logIndex.toString(16)}`,
        topics: [
            APPROVAL_TOPIC,
            addressToTopic(owner),
            addressToTopic(spender),
        ],
        transactionIndex: `0x${transactionIndex.toString(16)}`,
    };
}

function encodeUint256(value: bigint): Hex {
    return `0x${value.toString(16).padStart(64, "0")}` as Hex;
}

function addressToTopic(address: `0x${string}`): Hex {
    return `0x${address.slice(2).toLowerCase().padStart(64, "0")}` as Hex;
}

function makeIncidentRow(overrides: Partial<IncidentRow> = {}): IncidentRow {
    return {
        blockNumber: 24_200_000,
        rawAmount: "20000000",
        router: V3_ROUTER,
        routerCaller: ATTACKER,
        routerGeneration: "V3",
        attackerToken: TOKEN,
        traceAddress: "",
        txFrom: ATTACKER,
        txHash: "0x3333333333333333333333333333333333333333333333333333333333333333",
        victim: VICTIM,
        victimToken: TOKEN,
        ...overrides,
    };
}

describe("findExploitIncidents", () => {
    test("matches one exploit trace to the withdraw and pay transfer events", () => {
        const txHash = "0x770bc9a1f7c32cb63a5002b9ceb5c7994cd3af0fc6b2309cb32d3c46f629daa0" as const;
        const rows = findExploitIncidents({
            deployments: DEPLOYMENTS,
            logs: [
                makeTransferLog({ amount: 20_000_000n, from: V3_CORE_ADDRESS, logIndex: 0, to: ATTACKER, token: TOKEN }),
                makeTransferLog({ amount: 20_000_000n, from: VICTIM, logIndex: 1, to: V3_CORE_ADDRESS, token: TOKEN }),
            ],
            potentialExploitTraces: [
                {
                    match: makeExploitMatch(20_000_000n),
                    trace: makeTrace({
                        blockNumber: 24_200_000,
                        router: V3_ROUTER,
                        routerCaller: ATTACKER,
                        traceAddress: [],
                        txHash,
                    }),
                },
            ],
            txFrom: ATTACKER,
        });

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            rawAmount: "20000000",
            router: V3_ROUTER,
            routerCaller: ATTACKER,
            routerGeneration: "V3",
            attackerToken: TOKEN,
            traceAddress: "",
            txFrom: ATTACKER,
            txHash,
            victim: VICTIM,
            victimToken: TOKEN,
        });
    });

    test("divides repeated transfer events across repeated exploit traces", () => {
        const txHash = "0x1111111111111111111111111111111111111111111111111111111111111111" as const;
        const traces: PotentialExploitTrace[] = [
            {
                match: makeExploitMatch(20_000_000n),
                trace: makeTrace({
                    blockNumber: 24_200_001,
                    router: V3_ROUTER,
                    routerCaller: ATTACKER,
                    traceAddress: [0],
                    txHash,
                }),
            },
            {
                match: makeExploitMatch(20_000_000n),
                trace: makeTrace({
                    blockNumber: 24_200_001,
                    router: V3_ROUTER,
                    routerCaller: ATTACKER,
                    traceAddress: [1],
                    txHash,
                }),
            },
        ];

        const rows = findExploitIncidents({
            deployments: DEPLOYMENTS,
            logs: [
                makeTransferLog({ amount: 20_000_000n, from: V3_CORE_ADDRESS, logIndex: 0, to: ATTACKER, token: TOKEN }),
                makeTransferLog({ amount: 20_000_000n, from: VICTIM, logIndex: 1, to: V3_CORE_ADDRESS, token: TOKEN }),
                makeTransferLog({ amount: 20_000_000n, from: V3_CORE_ADDRESS, logIndex: 2, to: ATTACKER, token: TOKEN }),
                makeTransferLog({ amount: 20_000_000n, from: VICTIM, logIndex: 3, to: V3_CORE_ADDRESS, token: TOKEN }),
            ],
            potentialExploitTraces: traces,
            txFrom: ATTACKER,
        });

        expect(rows.map((row) => row.traceAddress)).toEqual(["0", "1"]);
    });

    test("omits rows when prior victim funding fully offsets the exploit loss", () => {
        const txHash = "0x2222222222222222222222222222222222222222222222222222222222222222" as const;
        const rows = findExploitIncidents({
            deployments: DEPLOYMENTS,
            logs: [
                makeTransferLog({ amount: 20_000_000n, from: FLASH_LENDER, logIndex: 0, to: ATTACKER, token: TOKEN }),
                makeTransferLog({ amount: 20_000_000n, from: ATTACKER, logIndex: 1, to: VICTIM, token: TOKEN }),
                makeTransferLog({ amount: 20_000_000n, from: V3_CORE_ADDRESS, logIndex: 2, to: ATTACKER, token: TOKEN }),
                makeTransferLog({ amount: 20_000_000n, from: VICTIM, logIndex: 3, to: V3_CORE_ADDRESS, token: TOKEN }),
                makeTransferLog({ amount: 20_000_000n, from: ATTACKER, logIndex: 4, to: FLASH_LENDER, token: TOKEN }),
            ],
            potentialExploitTraces: [
                {
                    match: makeExploitMatch(20_000_000n),
                    trace: makeTrace({
                        blockNumber: 24_200_002,
                        router: V3_ROUTER,
                        routerCaller: ATTACKER,
                        traceAddress: [],
                        txHash,
                    }),
                },
            ],
            txFrom: ATTACKER,
        });

        expect(rows).toEqual([]);
    });

    test("records only the victim's net loss after prior funding in the same tx", () => {
        const txHash = "0x32517e18e29fde8b04816bc335d7d66fc997b284183df288a41d8c34d290afcd" as const;
        const rows = findExploitIncidents({
            deployments: DEPLOYMENTS,
            logs: [
                makeTransferLog({ amount: 18_515_265n, from: FLASH_LENDER, logIndex: 0, to: ATTACKER, token: TOKEN }),
                makeTransferLog({ amount: 18_515_265n, from: ATTACKER, logIndex: 1, to: VICTIM, token: TOKEN }),
                makeTransferLog({ amount: 20_000_000n, from: V3_CORE_ADDRESS, logIndex: 2, to: ATTACKER, token: TOKEN }),
                makeTransferLog({ amount: 20_000_000n, from: VICTIM, logIndex: 3, to: V3_CORE_ADDRESS, token: TOKEN }),
                makeTransferLog({ amount: 1_484_735n, from: ATTACKER, logIndex: 4, to: OTHER_BOT, token: TOKEN }),
                makeTransferLog({ amount: 18_515_265n, from: ATTACKER, logIndex: 5, to: FLASH_LENDER, token: TOKEN }),
            ],
            potentialExploitTraces: [
                {
                    match: makeExploitMatch(20_000_000n),
                    trace: makeTrace({
                        blockNumber: 24_200_003,
                        router: V3_ROUTER,
                        routerCaller: ATTACKER,
                        traceAddress: [],
                        txHash,
                    }),
                },
            ],
            txFrom: ATTACKER,
        });

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            rawAmount: "1484735",
            txHash,
            victim: VICTIM,
        });
    });
});

describe("summarizeVictimLosses", () => {
    test("aggregates rows by victim and token", () => {
        const summary = summarizeVictimLosses([
            makeIncidentRow(),
            makeIncidentRow({
                blockNumber: 24_200_001,
                rawAmount: "30000000",
                traceAddress: "0",
                txHash: "0x4444444444444444444444444444444444444444444444444444444444444444",
            }),
        ]);

        expect(summary).toEqual({
            [VICTIM]: [
                {
                    amount: "50000000",
                    token: TOKEN,
                },
            ],
        });
    });
});

describe("summarizeTokenLosses", () => {
    test("aggregates rows by token", () => {
        const summary = summarizeTokenLosses([
            makeIncidentRow(),
            makeIncidentRow({
                blockNumber: 24_200_001,
                rawAmount: "30000000",
                traceAddress: "0",
                txHash: "0x4444444444444444444444444444444444444444444444444444444444444444",
            }),
        ]);

        expect(summary).toEqual([
            {
                amount: "50000000",
                token: TOKEN,
            },
        ]);
    });
});

describe("findVulnerableApprovals", () => {
    test("keeps approvals separated by router and computes effective amount as min(balance, allowance)", async () => {
        const spenderRouters = [V2_ROUTER, V2_ROUTER_ALT, V3_ROUTER] as const;
        const currentAllowanceByCallData = new Map<Hex, bigint>([
            [
                encodeFunctionData({
                    abi: ALLOWANCE_ABI,
                    functionName: "allowance",
                    args: [VICTIM, V2_ROUTER],
                }),
                MAX_UINT256,
            ],
            [
                encodeFunctionData({
                    abi: ALLOWANCE_ABI,
                    functionName: "allowance",
                    args: [VICTIM, V2_ROUTER_ALT],
                }),
                0n,
            ],
            [
                encodeFunctionData({
                    abi: ALLOWANCE_ABI,
                    functionName: "allowance",
                    args: [VICTIM, V3_ROUTER],
                }),
                8n,
            ],
        ]);
        const currentBalanceByCallData = new Map<Hex, bigint>([
            [
                encodeFunctionData({
                    abi: BALANCE_OF_ABI,
                    functionName: "balanceOf",
                    args: [VICTIM],
                }),
                7n,
            ],
        ]);

        const client = {
            request: vi.fn(async () => [
                makeApprovalLog({
                    blockNumber: 10,
                    logIndex: 1,
                    owner: VICTIM,
                    spender: V2_ROUTER,
                    token: TOKEN,
                    value: 5n,
                }),
                makeApprovalLog({
                    blockNumber: 11,
                    logIndex: 2,
                    owner: VICTIM,
                    spender: V2_ROUTER_ALT,
                    token: TOKEN,
                    value: 9n,
                }),
                makeApprovalLog({
                    blockNumber: 12,
                    logIndex: 3,
                    owner: VICTIM,
                    spender: V2_ROUTER_ALT,
                    token: TOKEN,
                    value: 8n,
                }),
                makeApprovalLog({
                    blockNumber: 13,
                    logIndex: 4,
                    owner: VICTIM,
                    spender: V2_ROUTER_ALT,
                    token: TOKEN,
                    value: 0n,
                }),
                makeApprovalLog({
                    blockNumber: 14,
                    logIndex: 5,
                    owner: VICTIM,
                    spender: V3_ROUTER,
                    token: TOKEN,
                    value: 8n,
                }),
            ]),
            call: vi.fn(async ({ data }) => {
                if (typeof data !== "string") {
                    throw new Error("missing calldata");
                }

                const currentAllowance = currentAllowanceByCallData.get(data as Hex);
                if (typeof currentAllowance !== "undefined") {
                    return { data: encodeUint256(currentAllowance) };
                }

                const currentBalance = currentBalanceByCallData.get(data as Hex);
                if (typeof currentBalance !== "undefined") {
                    return { data: encodeUint256(currentBalance) };
                }

                throw new Error(`unexpected calldata ${data}`);
            }),
        } as unknown as Pick<Client, "call" | "request">;

        const summary = await findVulnerableApprovals(client, {
            fromBlock: 1n,
            spenders: spenderRouters,
            tokens: [TOKEN],
        });

        expect(summary).toEqual({
            [V2_ROUTER]: {
                [TOKEN]: [
                    {
                        amount: "infinite",
                        effective: "7",
                        owner: VICTIM,
                    },
                ],
            },
            [V3_ROUTER]: {
                [TOKEN]: [
                    {
                        amount: "8",
                        effective: "7",
                        owner: VICTIM,
                    },
                ],
            },
        });
        expect(client.request).toHaveBeenCalledTimes(1);
    });
});
