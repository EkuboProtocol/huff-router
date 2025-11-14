import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import TOKENS from "../../tokens/31337.json" with {"type": "json"};
import { concatHex, Hex, IntegerOutOfRangeError, isAddress, padHex, parseEther, SizeExceedsPaddingSizeError } from "viem";
import { generateCalldata, Parameters, Swap } from "../src/index.js";
import { NATIVE_TOKEN_ADDRESS, INTEGRATOR, ORACLE_CONFIG, ERC20_FIRST_ADDRESS, CHAIN_ID, ERC20_SECOND_ADDRESS, TOKEN_WRAPPER_ADDRESS } from "./shared.js";
import { ERROR_CALCULATED_AMOUNT_THRESHOLD_RANGE, ERROR_CALCULATED_AMOUNT_THRESHOLD_SIGN, ERROR_CALCULATED_TOKEN_MISMATCH, ERROR_HOP_CONNECTION, ERROR_INVALID_SQRT_RATIO_LIMIT, ERROR_MULTIHOP_SWAPS_LENGTH, ERROR_SKIP_AHEAD_RANGE, ERROR_SPECIFIED_AMOUNT_MIXED_SIGN, ERROR_SPECIFIED_AMOUNT_RANGE, ERROR_HOPS_LENGTH, ERROR_TOKEN0_TOKEN1_ORDER, MAX_CALCULATED_AMOUNT_THRESHOLD, MAX_INTEGRATION_FEE, MAX_MULTIHOP_LENGTH, MAX_SKIP_AHEAD, MAX_SPECIFIED_AMOUNT, MAX_SQRT_RATIO, MAX_HOP_LENGTH, MIN_CALCULATED_AMOUNT_THRESHOLD, MIN_SPECIFIED_AMOUNT, MIN_SQRT_RATIO, ERROR_UNDERLYING_EQ_WRAPPED } from "../src/impl.js";

const VALID_ADDRESS = padHex("0x1", { size: 20 });
const OVERSIZED_ADDRESS = concatHex([VALID_ADDRESS, "0xff"]);
const MAX_CONTRACT_SIZE = 24_576n;
const MAX_TOKEN_LIST_LENGTH = 256;
const TOKENS_DIR = new URL("../../tokens/", import.meta.url);

function simpleParams({
    exactOut, poolConfig: poolConfig
}: {
    exactOut?: boolean,
    poolConfig?: Hex,
} = {}) {
    let specifiedAmount = parseEther("1");

    if (exactOut === true) {
        specifiedAmount = -specifiedAmount;
    }

    return structuredClone({
        chainId: CHAIN_ID,
        specifiedToken: NATIVE_TOKEN_ADDRESS,
        multiHops: [
            {
                specifiedAmount,
                hops: [
                    {
                        type: "swap",
                        poolKey: {
                            token0: NATIVE_TOKEN_ADDRESS,
                            token1: ERC20_FIRST_ADDRESS,
                            config: poolConfig ?? ORACLE_CONFIG,
                        },
                    } as Swap
                ],
            }
        ],
    });
}

test("test token list", async () => {
    expect(TOKENS).toStrictEqual([NATIVE_TOKEN_ADDRESS, ERC20_FIRST_ADDRESS, ERC20_SECOND_ADDRESS, TOKEN_WRAPPER_ADDRESS]);
    expect(TOKENS.every((token, i) => i === 0 || BigInt(TOKENS[i - 1]) < BigInt(token))).toBe(true);
});

test("token json constraints", () => {
    const tokenFiles = readdirSync(TOKENS_DIR);

    for (const file of tokenFiles) {
        const addresses: string[] = JSON.parse(readFileSync(new URL(file, TOKENS_DIR), "utf8"));

        expect(addresses.length).toBeLessThanOrEqual(MAX_TOKEN_LIST_LENGTH);

        for (const address of addresses) {
            expect(isAddress(address)).toBe(true);

            const numeric = BigInt(address);
            if (numeric !== 0n) {
                expect(numeric).toBeGreaterThanOrEqual(MAX_CONTRACT_SIZE);
            }
        }
    }
});

test("simple parameters", async () => {
    await expect(generateCalldata(simpleParams())).resolves.toBeDefined();
});

describe("specifiedToken", () => {
    describe("length", () => {
        test("valid", async () => {
            await expect(generateCalldata(simpleParams())).resolves.toBeDefined();
        });

        test("too long", async () => {
            const params: Parameters = simpleParams();
            params.specifiedToken = OVERSIZED_ADDRESS;

            await expect(generateCalldata(params)).rejects.toThrow(SizeExceedsPaddingSizeError);
        });
    });
});

describe("multiHopSwaps length", () => {
    test("zero", async () => {
        const params = simpleParams();
        params.multiHops = [];

        await expect(generateCalldata(params)).rejects.toThrow(ERROR_MULTIHOP_SWAPS_LENGTH);
    });

    test("one", async () => {
        await expect(generateCalldata(simpleParams())).resolves.toBeDefined();
    });

    test("valid", async () => {
        const params = simpleParams();
        params.multiHops = Array(10).fill(params.multiHops[0]);

        await expect(generateCalldata(params)).resolves.toBeDefined();
    });

    test("max", async () => {
        const params = simpleParams();
        params.multiHops = Array(MAX_MULTIHOP_LENGTH).fill(params.multiHops[0]);

        await expect(generateCalldata(params)).resolves.toBeDefined();
    });

    test("too large", async () => {
        const params = simpleParams();
        params.multiHops = Array(MAX_MULTIHOP_LENGTH + 1).fill(params.multiHops[0]);

        await expect(generateCalldata(params)).rejects.toThrow(ERROR_MULTIHOP_SWAPS_LENGTH);
    });
});

describe("hops", () => {
    describe("length", () => {
        function swaps(length: number): Swap[] {
            return Array<Swap>(length).fill({
                type: "swap",
                poolKey: {
                    token0: NATIVE_TOKEN_ADDRESS,
                    token1: ERC20_FIRST_ADDRESS,
                    config: ORACLE_CONFIG,
                }
            });
        }

        test("zero", async () => {
            const params = simpleParams();
            params.multiHops[0].hops = [];

            await expect(generateCalldata(params)).rejects.toThrow(ERROR_HOPS_LENGTH);
        });

        test("one", async () => {
            await expect(generateCalldata(simpleParams())).resolves.toBeDefined();
        });

        test("valid", async () => {
            const params = simpleParams();
            params.multiHops[0].hops = swaps(5);

            await expect(generateCalldata(params)).resolves.toBeDefined();
        });

        test("max", async () => {
            const params = simpleParams();
            params.multiHops[0].hops = swaps(MAX_HOP_LENGTH);

            await expect(generateCalldata(params)).resolves.toBeDefined();
        });

        test("too large", async () => {
            const params = simpleParams();
            params.multiHops[0].hops = swaps(MAX_HOP_LENGTH + 1);

            await expect(generateCalldata(params)).rejects.toThrow(ERROR_HOPS_LENGTH);
        });
    });

    describe("pool key", () => {
        describe("config", () => {
            describe("length", () => {
                test("valid", async () => {
                    const params = simpleParams();
                    params.multiHops[0].hops[0].poolKey.config = padHex("0x", { size: 32 });

                    await expect(generateCalldata(params)).resolves.toBeDefined();
                });

                test("length too long", async () => {
                    const params = simpleParams();
                    params.multiHops[0].hops[0].poolKey.config = padHex("0x", { size: 33 });

                    await expect(generateCalldata(params)).rejects.toThrow(SizeExceedsPaddingSizeError);
                });
            });
        });

        describe("tokens", () => {
            test("token0 == token1", async () => {
                const params = simpleParams();
                params.multiHops[0].hops[0].poolKey.token1 = NATIVE_TOKEN_ADDRESS;

                await expect(generateCalldata(params)).rejects.toThrow(ERROR_TOKEN0_TOKEN1_ORDER);
            });

            test("token0 > token1", async () => {
                const params = simpleParams();

                const poolKey = params.multiHops[0].hops[0].poolKey;
                [poolKey.token0, poolKey.token1] = [poolKey.token1, poolKey.token0];

                await expect(generateCalldata(params)).rejects.toThrow(ERROR_TOKEN0_TOKEN1_ORDER);
            });

            test("not connected", async () => {
                const params = simpleParams();
                params.multiHops[0].hops[0].poolKey.token0 = VALID_ADDRESS;

                await expect(generateCalldata(params)).rejects.toThrow(ERROR_HOP_CONNECTION);
            });
        });
    });

    describe("wrappedToken", () => {
        describe("tokens", () => {
            test("wrapped == underlying", async () => {
                const params: Parameters = simpleParams();
                params.multiHops[0].hops.push({
                    type: "wrappedToken",
                    underlying: ERC20_FIRST_ADDRESS,
                    wrapped: ERC20_FIRST_ADDRESS,
                });

                await expect(generateCalldata(params)).rejects.toThrow(ERROR_UNDERLYING_EQ_WRAPPED);
            });

            test("not connected", async () => {
                const params: Parameters = simpleParams();
                params.multiHops[0].hops.push({
                    type: "wrappedToken",
                    underlying: ERC20_SECOND_ADDRESS,
                    wrapped: VALID_ADDRESS,
                });

                await expect(generateCalldata(params)).rejects.toThrow(ERROR_HOP_CONNECTION);
            });
        })
    });
});

describe("specifiedAmount", () => {
    test("too small", async () => {
        const params = simpleParams();
        params.multiHops[0].specifiedAmount = MIN_SPECIFIED_AMOUNT - 1n;

        await expect(generateCalldata(params)).rejects.toThrow(ERROR_SPECIFIED_AMOUNT_RANGE);
    });

    test("min", async () => {
        const params = simpleParams();
        params.multiHops[0].specifiedAmount = MIN_SPECIFIED_AMOUNT;

        await expect(generateCalldata(params)).resolves.toBeDefined();
    });

    test("zero", async () => {
        const params = simpleParams();
        params.multiHops[0].specifiedAmount = 0n;

        await expect(generateCalldata(params)).resolves.toBeDefined();
    });

    test("valid", async () => {
        await expect(generateCalldata(simpleParams())).resolves.toBeDefined();
    });

    test("max", async () => {
        const params = simpleParams();
        params.multiHops[0].specifiedAmount = MAX_SPECIFIED_AMOUNT;

        await expect(generateCalldata(params)).resolves.toBeDefined();
    });

    test("too large", async () => {
        const params = simpleParams();
        params.multiHops[0].specifiedAmount = MAX_SPECIFIED_AMOUNT + 1n;

        await expect(generateCalldata(params)).rejects.toThrow(ERROR_SPECIFIED_AMOUNT_RANGE);
    });

    test("mixed sign", async () => {
        const params = simpleParams();

        params.multiHops.push(structuredClone(params.multiHops[0]));
        params.multiHops[1].specifiedAmount = -params.multiHops[1].specifiedAmount;

        await expect(generateCalldata(params)).rejects.toThrow(ERROR_SPECIFIED_AMOUNT_MIXED_SIGN);
    });
});

describe("sqrtRatioLimit", () => {
    test("too small", async () => {
        const params = simpleParams();
        params.multiHops[0].hops[0].sqrtRatioLimit = MIN_SQRT_RATIO - 1n;

        await expect(generateCalldata(params)).rejects.toThrow(ERROR_INVALID_SQRT_RATIO_LIMIT);
    });

    test("min", async () => {
        const params = simpleParams();
        params.multiHops[0].hops[0].sqrtRatioLimit = MIN_SQRT_RATIO;

        await expect(generateCalldata(params)).resolves.toBeDefined();
    });

    test("valid", async () => {
        const params = simpleParams();
        params.multiHops[0].hops[0].sqrtRatioLimit = 19807884935885858851817748830n;

        await expect(generateCalldata(params)).resolves.toBeDefined();
    });

    test("max", async () => {
        const params = simpleParams();
        params.multiHops[0].hops[0].sqrtRatioLimit = MAX_SQRT_RATIO;

        await expect(generateCalldata(params)).resolves.toBeDefined();
    });

    test("too large", async () => {
        const params = simpleParams();
        params.multiHops[0].hops[0].sqrtRatioLimit = MAX_SQRT_RATIO + 1n;

        await expect(generateCalldata(params)).rejects.toThrow(ERROR_INVALID_SQRT_RATIO_LIMIT);
    });

    test("whole number portion zero", async () => {
        const sqrtRatioLimit = 0xc00000000000000000000000n;

        expect(sqrtRatioLimit).toBeGreaterThanOrEqual(MIN_SQRT_RATIO);
        expect(sqrtRatioLimit).toBeLessThanOrEqual(MAX_SQRT_RATIO);

        const params = simpleParams();
        params.multiHops[0].hops[0].sqrtRatioLimit = sqrtRatioLimit;

        await expect(generateCalldata(params)).rejects.toThrow(ERROR_INVALID_SQRT_RATIO_LIMIT);
    });
});

describe("skipAhead", () => {
    test("negative", async () => {
        const params = simpleParams();
        params.multiHops[0].hops[0].skipAhead = -1;

        await expect(generateCalldata(params)).rejects.toThrow(ERROR_SKIP_AHEAD_RANGE);
    });

    test("min / zero", async () => {
        const params = simpleParams();
        params.multiHops[0].hops[0].skipAhead = 0;

        await expect(generateCalldata(params)).resolves.toBeDefined();
    });

    test("valid", async () => {
        const params = simpleParams();
        params.multiHops[0].hops[0].skipAhead = 10;

        await expect(generateCalldata(params)).resolves.toBeDefined();
    });

    test("max", async () => {
        const params = simpleParams();
        params.multiHops[0].hops[0].skipAhead = MAX_SKIP_AHEAD;

        await expect(generateCalldata(params)).resolves.toBeDefined();
    });

    test("too large", async () => {
        const params = simpleParams();
        params.multiHops[0].hops[0].skipAhead = MAX_SKIP_AHEAD + 1;

        await expect(generateCalldata(params)).rejects.toThrow(ERROR_SKIP_AHEAD_RANGE);
    });
});

describe("calculatedToken", () => {
    test("mismatch", async () => {
        const params = simpleParams();

        params.multiHops.push(structuredClone(params.multiHops[0]));
        params.multiHops[1].hops[0].poolKey.token1 = ERC20_SECOND_ADDRESS;

        await expect(generateCalldata(params)).rejects.toThrow(ERROR_CALCULATED_TOKEN_MISMATCH);
    });
});

describe("calculatedAmountThreshold", () => {
    describe("exact in", () => {
        test("too small / sign mismatch", async () => {
            const params: Parameters = simpleParams();
            params.calculatedAmountThreshold = -1n;

            await expect(generateCalldata(params)).rejects.toThrow(ERROR_CALCULATED_AMOUNT_THRESHOLD_SIGN);
        });

        test("zero / min", async () => {
            const params: Parameters = simpleParams();
            params.calculatedAmountThreshold = 0n;

            await expect(generateCalldata(params)).resolves.toBeDefined();
        });

        test("valid", async () => {
            const params: Parameters = simpleParams();
            params.calculatedAmountThreshold = 10n;

            await expect(generateCalldata(params)).resolves.toBeDefined();
        });

        test("max", async () => {
            const params: Parameters = simpleParams();
            params.calculatedAmountThreshold = MAX_CALCULATED_AMOUNT_THRESHOLD;

            await expect(generateCalldata(params)).resolves.toBeDefined();
        });

        test("too large", async () => {
            const params: Parameters = simpleParams();
            params.calculatedAmountThreshold = MAX_CALCULATED_AMOUNT_THRESHOLD + 1n;

            await expect(generateCalldata(params)).rejects.toThrow(ERROR_CALCULATED_AMOUNT_THRESHOLD_RANGE);
        });
    });

    describe("exact out", () => {
        test("too small", async () => {
            const params: Parameters = simpleParams({ exactOut: true });
            params.calculatedAmountThreshold = MIN_CALCULATED_AMOUNT_THRESHOLD - 1n;

            await expect(generateCalldata(params)).rejects.toThrow(ERROR_CALCULATED_AMOUNT_THRESHOLD_RANGE);
        });

        test("min", async () => {
            const params: Parameters = simpleParams({ exactOut: true });
            params.calculatedAmountThreshold = MIN_CALCULATED_AMOUNT_THRESHOLD;

            await expect(generateCalldata(params)).resolves.toBeDefined();
        });

        test("valid", async () => {
            const params: Parameters = simpleParams({ exactOut: true });
            params.calculatedAmountThreshold = -10n;

            await expect(generateCalldata(params)).resolves.toBeDefined();
        });

        test("zero / too large / sign mismatch", async () => {
            const params: Parameters = simpleParams({ exactOut: true });
            params.calculatedAmountThreshold = 0n;

            await expect(generateCalldata(params)).rejects.toThrow(ERROR_CALCULATED_AMOUNT_THRESHOLD_SIGN);
        });
    });
});

describe("integrationFee", () => {
    describe("fee", () => {
        test("negative", async () => {
            const params: Parameters = simpleParams();
            params.integrationFee = {
                fee: -1,
                integrator: INTEGRATOR,
            };

            await expect(generateCalldata(params)).rejects.toThrow(IntegerOutOfRangeError);
        });

        test("zero", async () => {
            const params: Parameters = simpleParams();
            params.integrationFee = {
                fee: 0,
                integrator: INTEGRATOR,
            };

            await expect(generateCalldata(params)).resolves.toBeDefined();
        });

        test("valid", async () => {
            const params: Parameters = simpleParams();
            params.integrationFee = {
                fee: 10,
                integrator: INTEGRATOR,
            };

            await expect(generateCalldata(params)).resolves.toBeDefined();
        });

        test("max", async () => {
            const params: Parameters = simpleParams();
            params.integrationFee = {
                fee: MAX_INTEGRATION_FEE,
                integrator: INTEGRATOR,
            };

            await expect(generateCalldata(params)).resolves.toBeDefined();
        });

        test("too large", async () => {
            const params: Parameters = simpleParams();
            params.integrationFee = {
                fee: MAX_INTEGRATION_FEE + 1,
                integrator: INTEGRATOR,
            };

            await expect(generateCalldata(params)).rejects.toThrow(IntegerOutOfRangeError);
        });
    });

    describe("integrator", () => {
        describe("length", () => {
            test("valid", async () => {
                const params: Parameters = simpleParams();
                params.integrationFee = {
                    fee: 10,
                    integrator: VALID_ADDRESS,
                };

                await expect(generateCalldata(simpleParams())).resolves.toBeDefined();
            });

            test("too long", async () => {
                const params: Parameters = simpleParams();
                params.integrationFee = {
                    fee: 10,
                    integrator: OVERSIZED_ADDRESS,
                };

                await expect(generateCalldata(params)).rejects.toThrow(SizeExceedsPaddingSizeError);
            });
        });
    });
});

describe("recipient", () => {
    describe("length", () => {
        test("valid", async () => {
            const params: Parameters = simpleParams();
            params.recipient = VALID_ADDRESS;

            await expect(generateCalldata(params)).resolves.toBeDefined();
        });

        test("too long", async () => {
            const params: Parameters = simpleParams();
            params.recipient = OVERSIZED_ADDRESS;

            await expect(generateCalldata(params)).rejects.toThrow(SizeExceedsPaddingSizeError);
        });
    });
});
