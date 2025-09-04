import { Address, concatHex, encodeAbiParameters, getAbiItem, Hex, hexToBigInt, maxUint256, numberToHex, parseEther, parseUnits, zeroAddress } from "viem";
import { hyperRouterTestAbi } from "./abi";
import { MEV_RESIST_ADDRESS, TWAMM_ADDRESS } from "../src/extensions";
import { generateCalldata, IntegrationFee, Hop } from "../src";
import { generateCalldataImpl, MAX_SQRT_RATIO, MIN_SQRT_RATIO } from "../src/impl";
import type { DeepWritable, ElementOf } from "ts-essentials";
import { ETH_ADDRESS, INTEGRATOR, ORACLE_CONFIG, USDC_ADDRESS, USDT_ADDRESS } from "./shared";

const EKUBO_ADDRESS = "0x04C46E830Bb56ce22735d5d8Fc9CB90309317d0f";
const gEKUBO_26Q2_ADDRESS = "0x0c93b16cb1D8691E629514Fc98f02cbaD340Da3C";

const ETH_SPECIFIED = parseEther("0.001");
const USDC_SPECIFIED = parseUnits("3", 6);
const EKUBO_SPECIFIED = parseEther("10");
const gEKUBO_26Q2_SPECIFIED = EKUBO_SPECIFIED;
const gEKUBO_26Q2_UNLOCK_TIME = 1775001600n;

const RECIPIENT: Address = "0x46b7916bCEC93409d18a4771C43dCCdddD62585E";
const INTEGRATION_FEE: IntegrationFee = {
    integrator: INTEGRATOR,
    fee: 32768, // 50%
};

interface PoolConfig {
    extension: Address;
    fee: bigint;
    tickSpacing: number;
}

function compressed(config: PoolConfig): Hex {
    return concatHex([
        config.extension,
        numberToHex(config.fee, { size: 8 }),
        numberToHex(config.tickSpacing, { size: 4 }),
    ]);
}

const ETH_USDC_2_BIPS = compressed({ extension: zeroAddress, fee: 3689348814741910n, tickSpacing: 4990 });
const ETH_USDT = compressed({ extension: zeroAddress, fee: 3689348814741910n, tickSpacing: 4990 });
const USDC_USDT = compressed({ extension: zeroAddress, fee: 92233720368547n, tickSpacing: 50 });
const TWAMM_ETH_USDC = compressed({ extension: TWAMM_ADDRESS, fee: 9223372036854775n, tickSpacing: 0 });
const MEV_RESIST_ETH_USDC = compressed({ extension: MEV_RESIST_ADDRESS, fee: 1844674407370954n, tickSpacing: 1000 });

interface PoolConfigWithName {
    poolConfig: Hex,
    asUnknownExtension: boolean,
    overrideBlockNumber?: bigint,
    extensionName: string,
}

const ETH_USDC_CONFIGS: PoolConfigWithName[] = [
    {
        poolConfig: ETH_USDC_2_BIPS,
        asUnknownExtension: false,
        extensionName: "base",
    },
    {
        poolConfig: ORACLE_CONFIG,
        asUnknownExtension: false,
        extensionName: "oracle",
    },
    {
        poolConfig: TWAMM_ETH_USDC,
        asUnknownExtension: false,
        extensionName: "twamm",
    },
    {
        poolConfig: MEV_RESIST_ETH_USDC,
        asUnknownExtension: false,
        overrideBlockNumber: 22968156n,
        extensionName: "mevResist",
    },
    {
        poolConfig: ETH_USDC_2_BIPS,
        asUnknownExtension: true,
        extensionName: "unknown",
    },
];

const inputs = getAbiItem({
    "abi": hyperRouterTestAbi,
    "name": "executeSdkCases",
}).inputs;

type SdkCases = DeepWritable<ElementOf<Parameters<typeof encodeAbiParameters<typeof inputs>>[1]>>;

const successCases: SdkCases["success"] = [
    {
        data: generateCalldata({
            specifiedToken: ETH_ADDRESS,
            recipient: RECIPIENT,
            calculatedAmountThreshold: parseUnits("2000", 6),
            integrationFee: INTEGRATION_FEE,
            multiHops: [
                {
                    specifiedAmount: parseEther("1"),
                    hops: [
                        {
                            type: "swap",
                            poolKey: {
                                token0: ETH_ADDRESS,
                                token1: USDC_ADDRESS,
                                config: TWAMM_ETH_USDC,
                            }
                        },
                        {
                            type: "swap",
                            poolKey: {
                                token0: USDC_ADDRESS,
                                token1: USDT_ADDRESS,
                                config: USDC_USDT,
                            },
                            skipAhead: 10,
                            sqrtRatioLimit: MIN_SQRT_RATIO,
                        }
                    ],
                },
                {
                    specifiedAmount: parseEther("0.5"),
                    hops: [
                        {
                            type: "swap",
                            poolKey: {
                                token0: ETH_ADDRESS,
                                token1: USDT_ADDRESS,
                                config: ETH_USDT,
                            },
                        }
                    ],
                },
            ]
        }),
        specifiedToken: ETH_ADDRESS,
        calculatedToken: USDT_ADDRESS,
        isExactOut: false,
        delegatecall: true,
        totalSpecified: parseEther("1.5"),
        recipient: RECIPIENT,
        integrator: INTEGRATION_FEE.integrator,
        overrideBlockNumber: 0n,
        overrideTimestamp: 0n,
        name: "example_scenario",
    }
];

// With the following test cases we want to achieve a high statement coverage (excluding errors).
// Since the Huff contract avoids reconciling jump branches and heavily inlines code,
// the number of input combinations usually grows exponentially with the number of decisions.

recipient: for (const recipient of [RECIPIENT, undefined] as const) {
    delegatecall: for (const delegatecall of [true, false]) {
        for (const isExactOut of [false, true]) {
            integrationFee: for (const integrationFee of [INTEGRATION_FEE, undefined]) {
                for (const withSqrtRatioLimit of [false, true]) {

                    function getSqrtRatioLimit(specifiedToken: Address, calculatedToken: Address) {
                        return withSqrtRatioLimit
                            ? (hexToBigInt(specifiedToken) > hexToBigInt(calculatedToken) === isExactOut)
                                ? MIN_SQRT_RATIO
                                : MAX_SQRT_RATIO
                            : undefined;
                    }

                    for (const asLastInMultiHop of [true, false]) {
                        for (const asUnknownToken of [false, true]) {
                            // For the last hops the calculated tokens aren't encoded anyway
                            if (asUnknownToken && asLastInMultiHop) {
                                continue;
                            }

                            function getTestcaseName(hopType: string, tokenIn: string) {
                                return `\
${typeof recipient === "undefined" ? "default" : "custom"}Recipient_\
${delegatecall ? "delegatecall" : "call"}_\
exact${isExactOut ? "Out" : "In"}_\
${typeof integrationFee === "undefined" ? "without" : "with"}IntegrationFee_\
${withSqrtRatioLimit ? "with" : "without"}SqrtRatioLimit_\
${hopType}_\
${asLastInMultiHop ? "last" : "notLast"}Swap_\
tokenIn${tokenIn}_\
${asUnknownToken ? "unknown" : "known"}Tokens`;
                            }

                            for (const { poolConfig, asUnknownExtension, overrideBlockNumber, extensionName } of ETH_USDC_CONFIGS) {
                                // Ideally we'd also have a loop over isToken1 here but ETH/USDC is currently the only pair
                                // that has pools of every extension type

                                // These two decisions don't depend on each other
                                const tokenInNative = asLastInMultiHop;

                                const [specifiedToken, specifiedAmount, firstCalculatedToken]: [Address, bigint, Address] = tokenInNative === isExactOut
                                    ? [
                                        USDC_ADDRESS,
                                        USDC_SPECIFIED,
                                        ETH_ADDRESS,
                                    ]
                                    : [
                                        ETH_ADDRESS,
                                        ETH_SPECIFIED,
                                        USDC_ADDRESS,
                                    ];



                                let hops: Hop[], calculatedToken: Address;

                                if (asLastInMultiHop) {
                                    calculatedToken = firstCalculatedToken;
                                    hops = [
                                        {
                                            type: "swap",
                                            poolKey: {
                                                token0: ETH_ADDRESS,
                                                token1: USDC_ADDRESS,
                                                config: poolConfig,
                                            },
                                            sqrtRatioLimit: getSqrtRatioLimit(specifiedToken, firstCalculatedToken),
                                        }
                                    ];
                                } else {
                                    const secondCalculatedToken = tokenInNative === isExactOut
                                        ? USDC_ADDRESS
                                        : ETH_ADDRESS;

                                    calculatedToken = secondCalculatedToken;

                                    hops = [
                                        {
                                            type: "swap",
                                            poolKey: {
                                                token0: ETH_ADDRESS,
                                                token1: USDC_ADDRESS,
                                                config: poolConfig,
                                            },
                                            sqrtRatioLimit: getSqrtRatioLimit(specifiedToken, firstCalculatedToken),
                                        },
                                        {
                                            type: "swap",
                                            poolKey: {
                                                token0: ETH_ADDRESS,
                                                token1: USDC_ADDRESS,
                                                config: ETH_USDC_2_BIPS,
                                            },
                                        },
                                    ];
                                }

                                const calldata = generateCalldataImpl({
                                    specifiedToken,
                                    recipient,
                                    multiHops: [
                                        {
                                            specifiedAmount: isExactOut ? -specifiedAmount : specifiedAmount,
                                            hops,
                                        }
                                    ],
                                    integrationFee,
                                }, {
                                    forceUnknownExtension: asUnknownExtension,
                                    forceUnknownToken: asUnknownToken,
                                });

                                successCases.push({
                                    data: calldata,
                                    specifiedToken,
                                    calculatedToken,
                                    isExactOut,
                                    delegatecall,
                                    totalSpecified: specifiedAmount,
                                    recipient: recipient ?? zeroAddress,
                                    integrator: integrationFee?.integrator ?? zeroAddress,
                                    overrideBlockNumber: overrideBlockNumber ?? 0n,
                                    overrideTimestamp: 0n,
                                    name: getTestcaseName(`${extensionName}Extension`, tokenInNative ? "Native" : "Erc20"),
                                } as const);

                                if (typeof integrationFee !== "undefined" || delegatecall || typeof recipient === "string") {
                                    break;
                                }
                            }

                            {
                                // sqrtRatioLimit is irrelevant when only a token wrap/unwrap happens
                                if (withSqrtRatioLimit && asLastInMultiHop) {
                                    continue;
                                }

                                for (const tokenInUnderlying of [true, false]) {
                                    const [specifiedToken, specifiedAmount, firstCalculatedToken]: [Address, bigint, Address] = tokenInUnderlying === isExactOut
                                        ? [
                                            gEKUBO_26Q2_ADDRESS,
                                            gEKUBO_26Q2_SPECIFIED,
                                            EKUBO_ADDRESS,
                                        ]
                                        : [
                                            EKUBO_ADDRESS,
                                            EKUBO_SPECIFIED,
                                            gEKUBO_26Q2_ADDRESS,
                                        ];

                                    let hops: Hop[], calculatedToken: Address;

                                    if (asLastInMultiHop) {
                                        calculatedToken = firstCalculatedToken;
                                        hops = [
                                            {
                                                type: "wrappedToken",
                                                underlying: EKUBO_ADDRESS,
                                                wrapped: gEKUBO_26Q2_ADDRESS,
                                            }
                                        ];
                                    } else {
                                        const secondCalculatedToken = tokenInUnderlying === isExactOut
                                            ? gEKUBO_26Q2_ADDRESS
                                            : EKUBO_ADDRESS;

                                        calculatedToken = secondCalculatedToken;

                                        hops = [
                                            {
                                                type: "wrappedToken",
                                                underlying: EKUBO_ADDRESS,
                                                wrapped: gEKUBO_26Q2_ADDRESS,
                                            },
                                            {
                                                type: "swap",
                                                poolKey: {
                                                    token0: EKUBO_ADDRESS,
                                                    token1: gEKUBO_26Q2_ADDRESS,
                                                    config: compressed({
                                                        extension: MEV_RESIST_ADDRESS,
                                                        fee: 18446744073709552n,
                                                        tickSpacing: 4988,
                                                    }),
                                                },
                                                sqrtRatioLimit: getSqrtRatioLimit(firstCalculatedToken, secondCalculatedToken),
                                            },
                                        ];
                                    }

                                    const calldata = generateCalldataImpl({
                                        specifiedToken,
                                        recipient,
                                        multiHops: [
                                            {
                                                specifiedAmount: isExactOut ? -specifiedAmount : specifiedAmount,
                                                hops,
                                            }
                                        ],
                                        integrationFee,
                                    }, {
                                        forceUnknownExtension: false,
                                        forceUnknownToken: asUnknownToken,
                                    });

                                    successCases.push({
                                        data: calldata,
                                        specifiedToken,
                                        calculatedToken,
                                        isExactOut,
                                        delegatecall,
                                        totalSpecified: specifiedAmount,
                                        recipient: recipient ?? zeroAddress,
                                        integrator: integrationFee?.integrator ?? zeroAddress,
                                        overrideBlockNumber: 23276148n,
                                        overrideTimestamp: gEKUBO_26Q2_UNLOCK_TIME,
                                        name: getTestcaseName("wrappedToken", tokenInUnderlying ? "Underlying" : "Wrapped"),
                                    } as const);

                                    if (typeof integrationFee !== "undefined") {
                                        continue integrationFee;
                                    } else if (delegatecall) {
                                        continue delegatecall;
                                    } else if (typeof recipient === "string") {
                                        continue recipient;
                                    }
                                }
                            }
                        }
                    }

                    for (const asLastInMultiHop of [true, false]) {
                        for (const asUnknownToken of [false, true]) {

                        }
                    }
                }

            }
        }
    }
}

const slippageCheckFailedCases: SdkCases["slippageCheckFailed"] = [
    {
        calculatedAmountThreshold: maxUint256,
        isExactOut: false,
        data: generateCalldata({
            specifiedToken: ETH_ADDRESS,
            multiHops: [{
                specifiedAmount: ETH_SPECIFIED,
                hops: [
                    {
                        type: "swap",
                        poolKey: {
                            token0: ETH_ADDRESS,
                            token1: USDC_ADDRESS,
                            config: ETH_USDC_2_BIPS,
                        }
                    }
                ]
            }],
            calculatedAmountThreshold: maxUint256,
        }),
    },
    {
        calculatedAmountThreshold: 1n,
        isExactOut: true,
        data: generateCalldata({
            specifiedToken: ETH_ADDRESS,
            multiHops: [{
                specifiedAmount: -ETH_SPECIFIED,
                hops: [
                    {
                        type: "swap",
                        poolKey: {
                            token0: ETH_ADDRESS,
                            token1: USDC_ADDRESS,
                            config: ETH_USDC_2_BIPS,
                        }
                    }
                ]
            }],
            calculatedAmountThreshold: -1n,
        }),
    },
];

console.log(encodeAbiParameters(inputs, [{
    success: successCases,
    slippageCheckFailed: slippageCheckFailedCases,
    refundEthNonPayable: {
        data: generateCalldata({
            specifiedToken: USDC_ADDRESS,
            multiHops: [
                {
                    specifiedAmount: -USDC_SPECIFIED,
                    hops: [
                        {
                            type: "swap",
                            poolKey: {
                                token0: ETH_ADDRESS,
                                token1: USDC_ADDRESS,
                                config: ETH_USDC_2_BIPS,
                            }
                        },
                    ],
                },
            ],
        }),
    },
}]));
