import { assert, describe, expect, test } from "vitest";
import TOKENS from "../../tokens/ethereum.json";
import { concatHex, Hex, IntegerOutOfRangeError, isAddress, padHex, parseEther, size, SizeExceedsPaddingSizeError } from "viem";
import { generateCalldata, Parameters, Swap } from "../src";
import { ETH_ADDRESS, INTEGRATOR, minimalCalldata, ORACLE_CONFIG, USDC_ADDRESS, USDT_ADDRESS } from "./shared";
import { ERROR_CALCULATED_AMOUNT_THRESHOLD_RANGE, ERROR_CALCULATED_AMOUNT_THRESHOLD_SIGN, ERROR_CALCULATED_TOKEN_MISMATCH, ERROR_HOP_CONNECTION, ERROR_INVALID_SQRT_RATIO_LIMIT, ERROR_MULTIHOP_SWAPS_LENGTH, ERROR_SKIP_AHEAD_RANGE, ERROR_SPECIFIED_AMOUNT_MIXED_SIGN, ERROR_SPECIFIED_AMOUNT_RANGE, ERROR_HOPS_LENGTH, ERROR_TOKEN0_TOKEN1_ORDER, MAX_CALCULATED_AMOUNT_THRESHOLD, MAX_INTEGRATION_FEE, MAX_MULTIHOP_LENGTH, MAX_SKIP_AHEAD, MAX_SPECIFIED_AMOUNT, MAX_SQRT_RATIO, MAX_HOP_LENGTH, MIN_CALCULATED_AMOUNT_THRESHOLD, MIN_SPECIFIED_AMOUNT, MIN_SQRT_RATIO, ERROR_UNDERLYING_EQ_WRAPPED } from "../src/impl";

const VALID_ADDRESS = padHex("0x1", { size: 20 });
const OVERSIZED_ADDRESS = concatHex([VALID_ADDRESS, "0xff"]);

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
        specifiedToken: ETH_ADDRESS,
        multiHops: [
            {
                specifiedAmount,
                hops: [
                    {
                        type: "swap",
                        poolKey: {
                            token0: ETH_ADDRESS,
                            token1: USDC_ADDRESS,
                            config: poolConfig ?? ORACLE_CONFIG,
                        },
                    } as Swap
                ],
            }
        ],
    });
}

test("minimal calldata size", () => {
    expect(size(minimalCalldata())).toBe(10);
});

test("token address checksums", () => {
    for (const { symbol, address } of TOKENS) {
        assert(isAddress(address), `${symbol} should have a checksummed address`);
    }
});

test("simple parameters", () => {
    expect(() => generateCalldata(simpleParams())).not.toThrow();
});

describe("specifiedToken", () => {
    describe("length", () => {
        test("valid", () => {
            expect(() => generateCalldata(simpleParams())).not.toThrow();
        });

        test("too long", () => {
            const params: Parameters = simpleParams();
            params.specifiedToken = OVERSIZED_ADDRESS;

            expect(() => generateCalldata(params)).toThrow(SizeExceedsPaddingSizeError);
        });
    });
});

describe("multiHopSwaps length", () => {
    test("zero", () => {
        const params = simpleParams();
        params.multiHops = [];

        expect(() => generateCalldata(params)).toThrow(ERROR_MULTIHOP_SWAPS_LENGTH);
    });

    test("one", () => {
        expect(() => generateCalldata(simpleParams())).not.toThrow();
    });

    test("valid", () => {
        const params = simpleParams();
        params.multiHops = Array(10).fill(params.multiHops[0]);

        expect(() => generateCalldata(params)).not.toThrow();
    });

    test("max", () => {
        const params = simpleParams();
        params.multiHops = Array(MAX_MULTIHOP_LENGTH).fill(params.multiHops[0]);

        expect(() => generateCalldata(params)).not.toThrow();
    });

    test("too large", () => {
        const params = simpleParams();
        params.multiHops = Array(MAX_MULTIHOP_LENGTH + 1).fill(params.multiHops[0]);

        expect(() => generateCalldata(params)).toThrow(ERROR_MULTIHOP_SWAPS_LENGTH);
    });
});

describe("hops", () => {
    describe("length", () => {
        function swaps(length: number): Swap[] {
            return Array<Swap>(length).fill({
                type: "swap",
                poolKey: {
                    token0: ETH_ADDRESS,
                    token1: USDC_ADDRESS,
                    config: ORACLE_CONFIG,
                }
            });
        }

        test("zero", () => {
            const params = simpleParams();
            params.multiHops[0].hops = [];

            expect(() => generateCalldata(params)).toThrow(ERROR_HOPS_LENGTH);
        });

        test("one", () => {
            expect(() => generateCalldata(simpleParams())).not.toThrow();
        });

        test("valid", () => {
            const params = simpleParams();
            params.multiHops[0].hops = swaps(5);

            expect(() => generateCalldata(params)).not.toThrow();
        });

        test("max", () => {
            const params = simpleParams();
            params.multiHops[0].hops = swaps(MAX_HOP_LENGTH);

            expect(() => generateCalldata(params)).not.toThrow();
        });

        test("too large", () => {
            const params = simpleParams();
            params.multiHops[0].hops = swaps(MAX_HOP_LENGTH + 1);

            expect(() => generateCalldata(params)).toThrow(ERROR_HOPS_LENGTH);
        });
    });

    describe("pool key", () => {
        describe("config", () => {
            describe("length", () => {
                test("valid", () => {
                    const params = simpleParams();
                    params.multiHops[0].hops[0].poolKey.config = padHex("0x", { size: 32 });

                    expect(() => generateCalldata(params)).not.toThrow();
                });

                test("length too long", () => {
                    const params = simpleParams();
                    params.multiHops[0].hops[0].poolKey.config = padHex("0x", { size: 33 });

                    expect(() => generateCalldata(params)).toThrow(SizeExceedsPaddingSizeError);
                });
            });
        });

        describe("tokens", () => {
            test("token0 == token1", () => {
                const params = simpleParams();
                params.multiHops[0].hops[0].poolKey.token1 = ETH_ADDRESS;

                expect(() => generateCalldata(params)).toThrow(ERROR_TOKEN0_TOKEN1_ORDER);
            });

            test("token0 > token1", () => {
                const params = simpleParams();

                const poolKey = params.multiHops[0].hops[0].poolKey;
                [poolKey.token0, poolKey.token1] = [poolKey.token1, poolKey.token0];

                expect(() => generateCalldata(params)).toThrow(ERROR_TOKEN0_TOKEN1_ORDER);
            });

            test("not connected", () => {
                const params = simpleParams();
                params.multiHops[0].hops[0].poolKey.token0 = VALID_ADDRESS;

                expect(() => generateCalldata(params)).toThrow(ERROR_HOP_CONNECTION);
            });
        });
    });

    describe("wrappedToken", () => {
        describe("tokens", () => {
            test("wrapped == underlying", () => {
                const params: Parameters = simpleParams();
                params.multiHops[0].hops.push({
                    type: "wrappedToken",
                    underlying: USDC_ADDRESS,
                    wrapped: USDC_ADDRESS,
                });

                expect(() => generateCalldata(params)).toThrow(ERROR_UNDERLYING_EQ_WRAPPED);
            });

            test("not connected", () => {
                const params: Parameters = simpleParams();
                params.multiHops[0].hops.push({
                    type: "wrappedToken",
                    underlying: USDT_ADDRESS,
                    wrapped: VALID_ADDRESS,
                });

                expect(() => generateCalldata(params)).toThrow(ERROR_HOP_CONNECTION);
            });
        })
    });
});

describe("specifiedAmount", () => {
    test("too small", () => {
        const params = simpleParams();
        params.multiHops[0].specifiedAmount = MIN_SPECIFIED_AMOUNT - 1n;

        expect(() => generateCalldata(params)).toThrow(ERROR_SPECIFIED_AMOUNT_RANGE);
    });

    test("min", () => {
        const params = simpleParams();
        params.multiHops[0].specifiedAmount = MIN_SPECIFIED_AMOUNT;

        expect(() => generateCalldata(params)).not.toThrow();
    });

    test("zero", () => {
        const params = simpleParams();
        params.multiHops[0].specifiedAmount = 0n;

        expect(() => generateCalldata(params)).not.toThrow();
    });

    test("valid", () => {
        expect(() => generateCalldata(simpleParams())).not.toThrow();
    });

    test("max", () => {
        const params = simpleParams();
        params.multiHops[0].specifiedAmount = MAX_SPECIFIED_AMOUNT;

        expect(() => generateCalldata(params)).not.toThrow();
    });

    test("too large", () => {
        const params = simpleParams();
        params.multiHops[0].specifiedAmount = MAX_SPECIFIED_AMOUNT + 1n;

        expect(() => generateCalldata(params)).toThrow(ERROR_SPECIFIED_AMOUNT_RANGE);
    });

    test("mixed sign", () => {
        const params = simpleParams();

        params.multiHops.push(structuredClone(params.multiHops[0]));
        params.multiHops[1].specifiedAmount = -params.multiHops[1].specifiedAmount;

        expect(() => generateCalldata(params)).toThrow(ERROR_SPECIFIED_AMOUNT_MIXED_SIGN);
    });
});

describe("sqrtRatioLimit", () => {
    test("too small", () => {
        const params = simpleParams();
        params.multiHops[0].hops[0].sqrtRatioLimit = MIN_SQRT_RATIO - 1n;

        expect(() => generateCalldata(params)).toThrow(ERROR_INVALID_SQRT_RATIO_LIMIT);
    });

    test("min", () => {
        const params = simpleParams();
        params.multiHops[0].hops[0].sqrtRatioLimit = MIN_SQRT_RATIO;

        expect(() => generateCalldata(params)).not.toThrow();
    });

    test("valid", () => {
        const params = simpleParams();
        params.multiHops[0].hops[0].sqrtRatioLimit = 19807884935885858851817748830n;

        expect(() => generateCalldata(params)).not.toThrow();
    });

    test("max", () => {
        const params = simpleParams();
        params.multiHops[0].hops[0].sqrtRatioLimit = MAX_SQRT_RATIO;

        expect(() => generateCalldata(params)).not.toThrow();
    });

    test("too large", () => {
        const params = simpleParams();
        params.multiHops[0].hops[0].sqrtRatioLimit = MAX_SQRT_RATIO + 1n;

        expect(() => generateCalldata(params)).toThrow(ERROR_INVALID_SQRT_RATIO_LIMIT);
    });

    test("whole number portion zero", () => {
        const sqrtRatioLimit = 0xc00000000000000000000000n;

        expect(sqrtRatioLimit).toBeGreaterThanOrEqual(MIN_SQRT_RATIO);
        expect(sqrtRatioLimit).toBeLessThanOrEqual(MAX_SQRT_RATIO);

        const params = simpleParams();
        params.multiHops[0].hops[0].sqrtRatioLimit = sqrtRatioLimit;

        expect(() => generateCalldata(params)).toThrow(ERROR_INVALID_SQRT_RATIO_LIMIT);
    });
});

describe("skipAhead", () => {
    test("negative", () => {
        const params = simpleParams();
        params.multiHops[0].hops[0].skipAhead = -1;

        expect(() => generateCalldata(params)).toThrow(ERROR_SKIP_AHEAD_RANGE);
    });

    test("min / zero", () => {
        const params = simpleParams();
        params.multiHops[0].hops[0].skipAhead = 0;

        expect(() => generateCalldata(params)).not.toThrow();
    });

    test("valid", () => {
        const params = simpleParams();
        params.multiHops[0].hops[0].skipAhead = 10;

        expect(() => generateCalldata(params)).not.toThrow();
    });

    test("max", () => {
        const params = simpleParams();
        params.multiHops[0].hops[0].skipAhead = MAX_SKIP_AHEAD;

        expect(() => generateCalldata(params)).not.toThrow();
    });

    test("too large", () => {
        const params = simpleParams();
        params.multiHops[0].hops[0].skipAhead = MAX_SKIP_AHEAD + 1;

        expect(() => generateCalldata(params)).toThrow(ERROR_SKIP_AHEAD_RANGE);
    });
});

describe("calculatedToken", () => {
    test("mismatch", () => {
        const params = simpleParams();

        params.multiHops.push(structuredClone(params.multiHops[0]));
        params.multiHops[1].hops[0].poolKey.token1 = USDT_ADDRESS;

        expect(() => generateCalldata(params)).toThrow(ERROR_CALCULATED_TOKEN_MISMATCH);
    });
});

describe("calculatedAmountThreshold", () => {
    describe("exact in", () => {
        test("too small / sign mismatch", () => {
            const params: Parameters = simpleParams();
            params.calculatedAmountThreshold = -1n;

            expect(() => generateCalldata(params)).toThrow(ERROR_CALCULATED_AMOUNT_THRESHOLD_SIGN);
        });

        test("zero / min", () => {
            const params: Parameters = simpleParams();
            params.calculatedAmountThreshold = 0n;

            expect(() => generateCalldata(params)).not.toThrow();
        });

        test("valid", () => {
            const params: Parameters = simpleParams();
            params.calculatedAmountThreshold = 10n;

            expect(() => generateCalldata(params)).not.toThrow();
        });

        test("max", () => {
            const params: Parameters = simpleParams();
            params.calculatedAmountThreshold = MAX_CALCULATED_AMOUNT_THRESHOLD;

            expect(() => generateCalldata(params)).not.toThrow();
        });

        test("too large", () => {
            const params: Parameters = simpleParams();
            params.calculatedAmountThreshold = MAX_CALCULATED_AMOUNT_THRESHOLD + 1n;

            expect(() => generateCalldata(params)).toThrow(ERROR_CALCULATED_AMOUNT_THRESHOLD_RANGE);
        });
    });

    describe("exact out", () => {
        test("too small", () => {
            const params: Parameters = simpleParams({ exactOut: true });
            params.calculatedAmountThreshold = MIN_CALCULATED_AMOUNT_THRESHOLD - 1n;

            expect(() => generateCalldata(params)).toThrow(ERROR_CALCULATED_AMOUNT_THRESHOLD_RANGE);
        });

        test("min", () => {
            const params: Parameters = simpleParams({ exactOut: true });
            params.calculatedAmountThreshold = MIN_CALCULATED_AMOUNT_THRESHOLD;

            expect(() => generateCalldata(params)).not.toThrow();
        });

        test("valid", () => {
            const params: Parameters = simpleParams({ exactOut: true });
            params.calculatedAmountThreshold = -10n;

            expect(() => generateCalldata(params)).not.toThrow();
        });

        test("zero / too large / sign mismatch", () => {
            const params: Parameters = simpleParams({ exactOut: true });
            params.calculatedAmountThreshold = 0n;

            expect(() => generateCalldata(params)).toThrow(ERROR_CALCULATED_AMOUNT_THRESHOLD_SIGN);
        });
    });
});

describe("integrationFee", () => {
    describe("fee", () => {
        test("negative", () => {
            const params: Parameters = simpleParams();
            params.integrationFee = {
                fee: -1,
                integrator: INTEGRATOR,
            };

            expect(() => generateCalldata(params)).toThrow(IntegerOutOfRangeError);
        });

        test("zero", () => {
            const params: Parameters = simpleParams();
            params.integrationFee = {
                fee: 0,
                integrator: INTEGRATOR,
            };

            expect(() => generateCalldata(params)).not.toThrow();
        });

        test("valid", () => {
            const params: Parameters = simpleParams();
            params.integrationFee = {
                fee: 10,
                integrator: INTEGRATOR,
            };

            expect(() => generateCalldata(params)).not.toThrow();
        });

        test("max", () => {
            const params: Parameters = simpleParams();
            params.integrationFee = {
                fee: MAX_INTEGRATION_FEE,
                integrator: INTEGRATOR,
            };

            expect(() => generateCalldata(params)).not.toThrow();
        });

        test("too large", () => {
            const params: Parameters = simpleParams();
            params.integrationFee = {
                fee: MAX_INTEGRATION_FEE + 1,
                integrator: INTEGRATOR,
            };

            expect(() => generateCalldata(params)).toThrow(IntegerOutOfRangeError);
        });
    });

    describe("integrator", () => {
        describe("length", () => {
            test("valid", () => {
                const params: Parameters = simpleParams();
                params.integrationFee = {
                    fee: 10,
                    integrator: VALID_ADDRESS,
                };

                expect(() => generateCalldata(simpleParams())).not.toThrow();
            });

            test("too long", () => {
                const params: Parameters = simpleParams();
                params.integrationFee = {
                    fee: 10,
                    integrator: OVERSIZED_ADDRESS,
                };

                expect(() => generateCalldata(params)).toThrow(SizeExceedsPaddingSizeError);
            });
        });
    });
});

describe("recipient", () => {
    describe("length", () => {
        test("valid", () => {
            const params: Parameters = simpleParams();
            params.recipient = VALID_ADDRESS;

            expect(() => generateCalldata(params)).not.toThrow();
        });

        test("too long", () => {
            const params: Parameters = simpleParams();
            params.recipient = OVERSIZED_ADDRESS;

            expect(() => generateCalldata(params)).toThrow(SizeExceedsPaddingSizeError);
        });
    });
});
