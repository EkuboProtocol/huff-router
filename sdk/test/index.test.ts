import { assert, describe, expect, test } from "vitest";
import TOKENS from "../../tokens/ethereum.json";
import { IntegerOutOfRangeError, InvalidAddressError, isAddress, parseEther, size, zeroAddress } from "viem";
import { generateCalldata, Parameters, PoolConfig, Swap } from "../src";
import { ETH_ADDRESS, INTEGRATOR, minimalCalldata, ORACLE_CONFIG, USDC_ADDRESS } from "./shared";
import { ERROR_CALCULATED_AMOUNT_THRESHOLD_RANGE, ERROR_CALCULATED_AMOUNT_THRESHOLD_SIGN, ERROR_CALCULATED_TOKEN_MISMATCH, ERROR_INVALID_SQRT_RATIO_LIMIT, ERROR_MULTIHOP_SWAPS_LENGTH, ERROR_SKIP_AHEAD_RANGE, ERROR_SPECIFIED_AMOUNT_MIXED_SIGN, ERROR_SPECIFIED_AMOUNT_RANGE, ERROR_SWAPS_LENGTH, MAX_CALCULATED_AMOUNT_THRESHOLD, MAX_FEE, MAX_INTEGRATION_FEE, MAX_MULTIHOP_SWAPS_LENGTH, MAX_SKIP_AHEAD, MAX_SPECIFIED_AMOUNT, MAX_SQRT_RATIO, MAX_SWAPS_LENGTH, MAX_TICK_SPACING, MIN_CALCULATED_AMOUNT_THRESHOLD, MIN_SPECIFIED_AMOUNT, MIN_SQRT_RATIO } from "../src/impl";
import { MEV_RESIST_ADDRESS, TWAMM_ADDRESS } from "../src/extensions";

const WRONG_LENGTH_ADDRESS = "0x1234";
const UNKNOWN_EXTENSION = "0x5a6D378003745d1235d6717f0311d9aB586deA82";

function simpleParams({
    exactOut, poolConfig
}: {
    exactOut?: boolean,
    poolConfig?: PoolConfig,
} = {}): Parameters {
    let specifiedAmount = parseEther("1");

    if (exactOut === true) {
        specifiedAmount = -specifiedAmount;
    }

    return structuredClone({
        specifiedToken: ETH_ADDRESS,
        multiHopSwaps: [
            {
                specifiedAmount,
                swaps: [
                    {
                        calculatedToken: USDC_ADDRESS,
                        poolConfig: poolConfig ?? ORACLE_CONFIG,
                    }
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
    test("wrong length", () => {
        const params = simpleParams();
        params.specifiedToken = WRONG_LENGTH_ADDRESS;

        expect(() => generateCalldata(params)).toThrow(InvalidAddressError);
    });
});

describe("multiHopSwaps length", () => {
    test("zero", () => {
        const params = simpleParams();
        params.multiHopSwaps = [];

        expect(() => generateCalldata(params)).toThrow(ERROR_MULTIHOP_SWAPS_LENGTH);
    });

    test("one", () => {
        expect(() => generateCalldata(simpleParams())).not.toThrow();
    });

    test("valid", () => {
        const params = simpleParams();
        params.multiHopSwaps = Array(10).fill(params.multiHopSwaps[0]);

        expect(() => generateCalldata(params)).not.toThrow();
    });

    test("max", () => {
        const params = simpleParams();
        params.multiHopSwaps = Array(MAX_MULTIHOP_SWAPS_LENGTH).fill(params.multiHopSwaps[0]);

        expect(() => generateCalldata(params)).not.toThrow();
    });

    test("too large", () => {
        const params = simpleParams();
        params.multiHopSwaps = Array(MAX_MULTIHOP_SWAPS_LENGTH + 1).fill(params.multiHopSwaps[0]);

        expect(() => generateCalldata(params)).toThrow(ERROR_MULTIHOP_SWAPS_LENGTH);
    });
});

describe("swaps", () => {
    describe("length", () => {
        function fillSwaps(swaps: Swap[]) {
            for (let i = 0; i < swaps.length; i++) {
                swaps[i] = {
                    calculatedToken: i % 2 ? ETH_ADDRESS : USDC_ADDRESS,
                    poolConfig: ORACLE_CONFIG,
                };
            }
        }

        test("zero", () => {
            const params = simpleParams();
            params.multiHopSwaps[0].swaps = [];

            expect(() => generateCalldata(params)).toThrow(ERROR_SWAPS_LENGTH);
        });

        test("one", () => {
            expect(() => generateCalldata(simpleParams())).not.toThrow();
        });

        test("valid", () => {
            const params = simpleParams();

            const swaps: Swap[] = Array(5);
            fillSwaps(swaps);

            params.multiHopSwaps[0].swaps = swaps;

            expect(() => generateCalldata(params)).not.toThrow();
        });

        test("max", () => {
            const params = simpleParams();

            const swaps: Swap[] = Array(MAX_SWAPS_LENGTH);
            fillSwaps(swaps);

            params.multiHopSwaps[0].swaps = swaps;

            expect(() => generateCalldata(params)).not.toThrow();
        });

        test("too large", () => {
            const params = simpleParams();

            const swaps: Swap[] = Array(MAX_SWAPS_LENGTH + 1);
            fillSwaps(swaps);

            params.multiHopSwaps[0].swaps = swaps;

            expect(() => generateCalldata(params)).toThrow(ERROR_SWAPS_LENGTH);
        });
    });

    describe("extension", () => {
        test("wrong length", () => {
            const params = simpleParams();
            params.multiHopSwaps[0].swaps[0].poolConfig.extension = WRONG_LENGTH_ADDRESS;

            expect(() => generateCalldata(params)).toThrow(InvalidAddressError);
        });

        describe("base", () => {
            describe("fee", () => {
                test("negative", () => {
                    expect(() => generateCalldata(simpleParams({
                        poolConfig: {
                            extension: zeroAddress,
                            fee: -1n,
                            tickSpacing: 0,
                        }
                    }))).toThrow(IntegerOutOfRangeError);
                });

                test("zero", () => {
                    expect(() => generateCalldata(simpleParams({
                        poolConfig: {
                            extension: zeroAddress,
                            fee: 0n,
                            tickSpacing: 0,
                        }
                    }))).not.toThrow();
                });

                test("valid", () => {
                    expect(() => generateCalldata(simpleParams({
                        poolConfig: {
                            extension: zeroAddress,
                            fee: 10n,
                            tickSpacing: 0,
                        }
                    }))).not.toThrow();
                });

                test("max", () => {
                    expect(() => generateCalldata(simpleParams({
                        poolConfig: {
                            extension: zeroAddress,
                            fee: MAX_FEE,
                            tickSpacing: 0,
                        }
                    }))).not.toThrow();
                });

                test("too large", () => {
                    expect(() => generateCalldata(simpleParams({
                        poolConfig: {
                            extension: zeroAddress,
                            fee: MAX_FEE + 1n,
                            tickSpacing: 0,
                        }
                    }))).toThrow(IntegerOutOfRangeError);
                });
            });

            describe("tickSpacing", () => {
                test("negative", () => {
                    expect(() => generateCalldata(simpleParams({
                        poolConfig: {
                            extension: zeroAddress,
                            fee: 0n,
                            tickSpacing: -1,
                        }
                    }))).toThrow(IntegerOutOfRangeError);
                });

                test("zero", () => {
                    expect(() => generateCalldata(simpleParams({
                        poolConfig: {
                            extension: zeroAddress,
                            fee: 0n,
                            tickSpacing: 0,
                        }
                    }))).not.toThrow();
                });

                test("valid", () => {
                    expect(() => generateCalldata(simpleParams({
                        poolConfig: {
                            extension: zeroAddress,
                            fee: 0n,
                            tickSpacing: 10,
                        }
                    }))).not.toThrow();
                });

                test("max", () => {
                    expect(() => generateCalldata(simpleParams({
                        poolConfig: {
                            extension: zeroAddress,
                            fee: 0n,
                            tickSpacing: MAX_TICK_SPACING,
                        }
                    }))).not.toThrow();
                });

                test("too large", () => {
                    expect(() => generateCalldata(simpleParams({
                        poolConfig: {
                            extension: zeroAddress,
                            fee: 0n,
                            tickSpacing: MAX_TICK_SPACING + 1,
                        }
                    }))).toThrow(IntegerOutOfRangeError);
                });
            });
        });

        describe("twamm", () => {
            describe("fee", () => {
                test("negative", () => {
                    expect(() => generateCalldata(simpleParams({
                        poolConfig: {
                            extension: TWAMM_ADDRESS,
                            fee: -1n,
                            tickSpacing: 0,
                        }
                    }))).toThrow(IntegerOutOfRangeError);
                });

                test("zero", () => {
                    expect(() => generateCalldata(simpleParams({
                        poolConfig: {
                            extension: TWAMM_ADDRESS,
                            fee: 0n,
                            tickSpacing: 0,
                        }
                    }))).not.toThrow();
                });

                test("valid", () => {
                    expect(() => generateCalldata(simpleParams({
                        poolConfig: {
                            extension: TWAMM_ADDRESS,
                            fee: 10n,
                            tickSpacing: 0,
                        }
                    }))).not.toThrow();
                });

                test("max", () => {
                    expect(() => generateCalldata(simpleParams({
                        poolConfig: {
                            extension: TWAMM_ADDRESS,
                            fee: MAX_FEE,
                            tickSpacing: 0,
                        }
                    }))).not.toThrow();
                });

                test("too large", () => {
                    expect(() => generateCalldata(simpleParams({
                        poolConfig: {
                            extension: TWAMM_ADDRESS,
                            fee: MAX_FEE + 1n,
                            tickSpacing: 0,
                        }
                    }))).toThrow(IntegerOutOfRangeError);
                });
            });
        });

        describe("mevResist", () => {
            describe("fee", () => {
                test("negative", () => {
                    expect(() => generateCalldata(simpleParams({
                        poolConfig: {
                            extension: MEV_RESIST_ADDRESS,
                            fee: -1n,
                            tickSpacing: 0,
                        }
                    }))).toThrow(IntegerOutOfRangeError);
                });

                test("zero", () => {
                    expect(() => generateCalldata(simpleParams({
                        poolConfig: {
                            extension: MEV_RESIST_ADDRESS,
                            fee: 0n,
                            tickSpacing: 0,
                        }
                    }))).not.toThrow();
                });

                test("valid", () => {
                    expect(() => generateCalldata(simpleParams({
                        poolConfig: {
                            extension: MEV_RESIST_ADDRESS,
                            fee: 10n,
                            tickSpacing: 0,
                        }
                    }))).not.toThrow();
                });

                test("max", () => {
                    expect(() => generateCalldata(simpleParams({
                        poolConfig: {
                            extension: MEV_RESIST_ADDRESS,
                            fee: MAX_FEE,
                            tickSpacing: 0,
                        }
                    }))).not.toThrow();
                });

                test("too large", () => {
                    expect(() => generateCalldata(simpleParams({
                        poolConfig: {
                            extension: MEV_RESIST_ADDRESS,
                            fee: MAX_FEE + 1n,
                            tickSpacing: 0,
                        }
                    }))).toThrow(IntegerOutOfRangeError);
                });
            });

            describe("tickSpacing", () => {
                test("negative", () => {
                    expect(() => generateCalldata(simpleParams({
                        poolConfig: {
                            extension: MEV_RESIST_ADDRESS,
                            fee: 0n,
                            tickSpacing: -1,
                        }
                    }))).toThrow(IntegerOutOfRangeError);
                });

                test("zero", () => {
                    expect(() => generateCalldata(simpleParams({
                        poolConfig: {
                            extension: MEV_RESIST_ADDRESS,
                            fee: 0n,
                            tickSpacing: 0,
                        }
                    }))).not.toThrow();
                });

                test("valid", () => {
                    expect(() => generateCalldata(simpleParams({
                        poolConfig: {
                            extension: MEV_RESIST_ADDRESS,
                            fee: 0n,
                            tickSpacing: 10,
                        }
                    }))).not.toThrow();
                });

                test("max", () => {
                    expect(() => generateCalldata(simpleParams({
                        poolConfig: {
                            extension: MEV_RESIST_ADDRESS,
                            fee: 0n,
                            tickSpacing: MAX_TICK_SPACING,
                        }
                    }))).not.toThrow();
                });

                test("too large", () => {
                    expect(() => generateCalldata(simpleParams({
                        poolConfig: {
                            extension: MEV_RESIST_ADDRESS,
                            fee: 0n,
                            tickSpacing: MAX_TICK_SPACING + 1,
                        }
                    }))).toThrow(IntegerOutOfRangeError);
                });
            });
        });

        describe("unknown", () => {
            describe("fee", () => {
                test("negative", () => {
                    expect(() => generateCalldata(simpleParams({
                        poolConfig: {
                            extension: UNKNOWN_EXTENSION,
                            fee: -1n,
                            tickSpacing: 0,
                        }
                    }))).toThrow(IntegerOutOfRangeError);
                });

                test("zero", () => {
                    expect(() => generateCalldata(simpleParams({
                        poolConfig: {
                            extension: UNKNOWN_EXTENSION,
                            fee: 0n,
                            tickSpacing: 0,
                        }
                    }))).not.toThrow();
                });

                test("valid", () => {
                    expect(() => generateCalldata(simpleParams({
                        poolConfig: {
                            extension: UNKNOWN_EXTENSION,
                            fee: 10n,
                            tickSpacing: 0,
                        }
                    }))).not.toThrow();
                });

                test("max", () => {
                    expect(() => generateCalldata(simpleParams({
                        poolConfig: {
                            extension: UNKNOWN_EXTENSION,
                            fee: MAX_FEE,
                            tickSpacing: 0,
                        }
                    }))).not.toThrow();
                });

                test("too large", () => {
                    expect(() => generateCalldata(simpleParams({
                        poolConfig: {
                            extension: UNKNOWN_EXTENSION,
                            fee: MAX_FEE + 1n,
                            tickSpacing: 0,
                        }
                    }))).toThrow(IntegerOutOfRangeError);
                });
            });

            describe("tickSpacing", () => {
                test("negative", () => {
                    expect(() => generateCalldata(simpleParams({
                        poolConfig: {
                            extension: UNKNOWN_EXTENSION,
                            fee: 0n,
                            tickSpacing: -1,
                        }
                    }))).toThrow(IntegerOutOfRangeError);
                });

                test("zero", () => {
                    expect(() => generateCalldata(simpleParams({
                        poolConfig: {
                            extension: UNKNOWN_EXTENSION,
                            fee: 0n,
                            tickSpacing: 0,
                        }
                    }))).not.toThrow();
                });

                test("valid", () => {
                    expect(() => generateCalldata(simpleParams({
                        poolConfig: {
                            extension: UNKNOWN_EXTENSION,
                            fee: 0n,
                            tickSpacing: 10,
                        }
                    }))).not.toThrow();
                });

                test("max", () => {
                    expect(() => generateCalldata(simpleParams({
                        poolConfig: {
                            extension: UNKNOWN_EXTENSION,
                            fee: 0n,
                            tickSpacing: MAX_TICK_SPACING,
                        }
                    }))).not.toThrow();
                });

                test("too large", () => {
                    expect(() => generateCalldata(simpleParams({
                        poolConfig: {
                            extension: UNKNOWN_EXTENSION,
                            fee: 0n,
                            tickSpacing: MAX_TICK_SPACING + 1,
                        }
                    }))).toThrow(IntegerOutOfRangeError);
                });
            });
        });
    });
});

describe("specifiedAmount", () => {
    test("too small", () => {
        const params = simpleParams();
        params.multiHopSwaps[0].specifiedAmount = MIN_SPECIFIED_AMOUNT - 1n;

        expect(() => generateCalldata(params)).toThrow(ERROR_SPECIFIED_AMOUNT_RANGE);
    });

    test("min", () => {
        const params = simpleParams();
        params.multiHopSwaps[0].specifiedAmount = MIN_SPECIFIED_AMOUNT;

        expect(() => generateCalldata(params)).not.toThrow();
    });

    test("zero", () => {
        const params = simpleParams();
        params.multiHopSwaps[0].specifiedAmount = 0n;

        expect(() => generateCalldata(params)).not.toThrow();
    });

    test("valid", () => {
        expect(() => generateCalldata(simpleParams())).not.toThrow();
    });

    test("max", () => {
        const params = simpleParams();
        params.multiHopSwaps[0].specifiedAmount = MAX_SPECIFIED_AMOUNT;

        expect(() => generateCalldata(params)).not.toThrow();
    });

    test("too large", () => {
        const params = simpleParams();
        params.multiHopSwaps[0].specifiedAmount = MAX_SPECIFIED_AMOUNT + 1n;

        expect(() => generateCalldata(params)).toThrow(ERROR_SPECIFIED_AMOUNT_RANGE);
    });

    test("mixed sign", () => {
        const params = simpleParams();

        params.multiHopSwaps.push(structuredClone(params.multiHopSwaps[0]));
        params.multiHopSwaps[1].specifiedAmount = -params.multiHopSwaps[1].specifiedAmount;

        expect(() => generateCalldata(params)).toThrow(ERROR_SPECIFIED_AMOUNT_MIXED_SIGN);
    });
});

describe("sqrtRatioLimit", () => {
    test("too small", () => {
        const params = simpleParams();
        params.multiHopSwaps[0].swaps[0].sqrtRatioLimit = MIN_SQRT_RATIO - 1n;

        expect(() => generateCalldata(params)).toThrow(ERROR_INVALID_SQRT_RATIO_LIMIT);
    });

    test("min", () => {
        const params = simpleParams();
        params.multiHopSwaps[0].swaps[0].sqrtRatioLimit = MIN_SQRT_RATIO;

        expect(() => generateCalldata(params)).not.toThrow();
    });

    test("valid", () => {
        const params = simpleParams();
        params.multiHopSwaps[0].swaps[0].sqrtRatioLimit = 19807884935885858851817748830n;

        expect(() => generateCalldata(params)).not.toThrow();
    });

    test("max", () => {
        const params = simpleParams();
        params.multiHopSwaps[0].swaps[0].sqrtRatioLimit = MAX_SQRT_RATIO;

        expect(() => generateCalldata(params)).not.toThrow();
    });

    test("too large", () => {
        const params = simpleParams();
        params.multiHopSwaps[0].swaps[0].sqrtRatioLimit = MAX_SQRT_RATIO + 1n;

        expect(() => generateCalldata(params)).toThrow(ERROR_INVALID_SQRT_RATIO_LIMIT);
    });

    test("whole number portion zero", () => {
        const sqrtRatioLimit = 0xc00000000000000000000000n;

        expect(sqrtRatioLimit).toBeGreaterThanOrEqual(MIN_SQRT_RATIO);
        expect(sqrtRatioLimit).toBeLessThanOrEqual(MAX_SQRT_RATIO);

        const params = simpleParams();
        params.multiHopSwaps[0].swaps[0].sqrtRatioLimit = sqrtRatioLimit;

        expect(() => generateCalldata(params)).toThrow(ERROR_INVALID_SQRT_RATIO_LIMIT);
    });
});

describe("skipAhead", () => {
    test("negative", () => {
        const params = simpleParams();
        params.multiHopSwaps[0].swaps[0].skipAhead = -1;

        expect(() => generateCalldata(params)).toThrow(ERROR_SKIP_AHEAD_RANGE);
    });

    test("min / zero", () => {
        const params = simpleParams();
        params.multiHopSwaps[0].swaps[0].skipAhead = 0;

        expect(() => generateCalldata(params)).not.toThrow();
    });

    test("valid", () => {
        const params = simpleParams();
        params.multiHopSwaps[0].swaps[0].skipAhead = 10;

        expect(() => generateCalldata(params)).not.toThrow();
    });

    test("max", () => {
        const params = simpleParams();
        params.multiHopSwaps[0].swaps[0].skipAhead = MAX_SKIP_AHEAD;

        expect(() => generateCalldata(params)).not.toThrow();
    });

    test("too large", () => {
        const params = simpleParams();
        params.multiHopSwaps[0].swaps[0].skipAhead = MAX_SKIP_AHEAD + 1;

        expect(() => generateCalldata(params)).toThrow(ERROR_SKIP_AHEAD_RANGE);
    });
});

describe("calculatedToken", () => {
    test("mismatch", () => {
        const params = simpleParams();

        params.multiHopSwaps.push(structuredClone(params.multiHopSwaps[0]));
        params.multiHopSwaps[1].swaps[0].calculatedToken = ETH_ADDRESS;

        expect(() => generateCalldata(params)).toThrow(ERROR_CALCULATED_TOKEN_MISMATCH);
    });

    test("wrong length", () => {
        const params = simpleParams();
        params.multiHopSwaps[0].swaps[0].calculatedToken = WRONG_LENGTH_ADDRESS;

        expect(() => generateCalldata(params)).toThrow(InvalidAddressError);
    });
});

describe("calculatedAmountThreshold", () => {
    describe("exact in", () => {
        test("too small / sign mismatch", () => {
            const params = simpleParams();
            params.calculatedAmountThreshold = -1n;

            expect(() => generateCalldata(params)).toThrow(ERROR_CALCULATED_AMOUNT_THRESHOLD_SIGN);
        });

        test("zero / min", () => {
            const params = simpleParams();
            params.calculatedAmountThreshold = 0n;

            expect(() => generateCalldata(params)).not.toThrow();
        });

        test("valid", () => {
            const params = simpleParams();
            params.calculatedAmountThreshold = 10n;

            expect(() => generateCalldata(params)).not.toThrow();
        });

        test("max", () => {
            const params = simpleParams();
            params.calculatedAmountThreshold = MAX_CALCULATED_AMOUNT_THRESHOLD;

            expect(() => generateCalldata(params)).not.toThrow();
        });

        test("too large", () => {
            const params = simpleParams();
            params.calculatedAmountThreshold = MAX_CALCULATED_AMOUNT_THRESHOLD + 1n;

            expect(() => generateCalldata(params)).toThrow(ERROR_CALCULATED_AMOUNT_THRESHOLD_RANGE);
        });
    });

    describe("exact out", () => {
        test("too small", () => {
            const params = simpleParams({ exactOut: true });
            params.calculatedAmountThreshold = MIN_CALCULATED_AMOUNT_THRESHOLD - 1n;

            expect(() => generateCalldata(params)).toThrow(ERROR_CALCULATED_AMOUNT_THRESHOLD_RANGE);
        });

        test("min", () => {
            const params = simpleParams({ exactOut: true });
            params.calculatedAmountThreshold = MIN_CALCULATED_AMOUNT_THRESHOLD;

            expect(() => generateCalldata(params)).not.toThrow();
        });

        test("valid", () => {
            const params = simpleParams({ exactOut: true });
            params.calculatedAmountThreshold = -10n;

            expect(() => generateCalldata(params)).not.toThrow();
        });

        test("zero / too large / sign mismatch", () => {
            const params = simpleParams({ exactOut: true });
            params.calculatedAmountThreshold = 0n;

            expect(() => generateCalldata(params)).toThrow(ERROR_CALCULATED_AMOUNT_THRESHOLD_SIGN);
        });
    });
});

describe("integrationFee", () => {
    describe("fee", () => {
        test("negative", () => {
            const params = simpleParams();
            params.integrationFee = {
                fee: -1,
                integrator: INTEGRATOR,
            };

            expect(() => generateCalldata(params)).toThrow(IntegerOutOfRangeError);
        });

        test("zero", () => {
            const params = simpleParams();
            params.integrationFee = {
                fee: 0,
                integrator: INTEGRATOR,
            };

            expect(() => generateCalldata(params)).not.toThrow();
        });

        test("valid", () => {
            const params = simpleParams();
            params.integrationFee = {
                fee: 10,
                integrator: INTEGRATOR,
            };

            expect(() => generateCalldata(params)).not.toThrow();
        });

        test("max", () => {
            const params = simpleParams();
            params.integrationFee = {
                fee: MAX_INTEGRATION_FEE,
                integrator: INTEGRATOR,
            };

            expect(() => generateCalldata(params)).not.toThrow();
        });

        test("too large", () => {
            const params = simpleParams();
            params.integrationFee = {
                fee: MAX_INTEGRATION_FEE + 1,
                integrator: INTEGRATOR,
            };

            expect(() => generateCalldata(params)).toThrow(IntegerOutOfRangeError);
        });
    });

    describe("integrator", () => {
        test("wrong length", () => {
            const params = simpleParams();
            params.integrationFee = {
                fee: 10,
                integrator: WRONG_LENGTH_ADDRESS,
            };

            expect(() => generateCalldata(params)).toThrow(InvalidAddressError);
        });
    });
});

describe("recipient", () => {
    test("wrong length", () => {
        const params = simpleParams();
        params.recipient = WRONG_LENGTH_ADDRESS;

        expect(() => generateCalldata(params)).toThrow(InvalidAddressError);
    });
});
