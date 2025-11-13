import { Address, concatHex, encodeAbiParameters, getAbiItem, Hex, hexToBigInt, maxUint256, numberToHex, parseEther, parseUnits, zeroAddress } from "viem";
import { hyperRouterTestAbi } from "./abi.js";
import { MEV_CAPTURE_ADDRESS, TWAMM_ADDRESS } from "../src/extensions.js";
import { generateCalldata, IntegrationFee, Hop } from "../src/index.js";
import { generateCalldataImpl, MAX_SQRT_RATIO, MIN_SQRT_RATIO } from "../src/impl.js";
import type { DeepWritable, ElementOf } from "ts-essentials";
import { NATIVE_TOKEN_ADDRESS, INTEGRATOR, ORACLE_CONFIG, CHAIN_ID, ERC20_FIRST_ADDRESS, ERC20_SECOND_ADDRESS, TOKEN_WRAPPER_ADDRESS } from "./shared.js";

const SPECIFIED_AMOUNT = parseEther("1");
const RECIPIENT: Address = "0xffffffffffffffffffffffffffffffffffffffff";
const INTEGRATION_FEE: IntegrationFee = {
    integrator: INTEGRATOR,
    fee: 2 ** 15, // 50%
};

interface PoolConfig {
    extension: Address;
    fee: bigint;
    poolTypeConfig: bigint;
}

function concentratedPoolTypeConfig(tickSpacing: number): bigint {
    return 0x80000000n | BigInt(tickSpacing)
}

function stableswapPoolTypeConfig(amplificationFactor: number, centerTick: number): bigint {
    return BigInt(amplificationFactor) << 24n | BigInt.asIntN(24, BigInt(centerTick));
}

const FULL_RANGE_POOL_TYPE_CONFIG = 0n;

function compressed(config: PoolConfig): Hex {
    return concatHex([
        config.extension,
        numberToHex(config.fee, { size: 8 }),
        numberToHex(config.poolTypeConfig, { size: 4 }),
    ]);
}

const CONCENTRATED_CONFIG = compressed({ extension: zeroAddress, fee: 3689348814741910n, poolTypeConfig: concentratedPoolTypeConfig(4990) });
const STABLESWAP_CONFIG = compressed({ extension: zeroAddress, fee: 3689348814741910n, poolTypeConfig: stableswapPoolTypeConfig(10, 0) });
const FULL_RANGE_CONFIG = compressed({ extension: zeroAddress, fee: 92233720368547n, poolTypeConfig: FULL_RANGE_POOL_TYPE_CONFIG });
const TWAMM_CONFIG = compressed({ extension: TWAMM_ADDRESS, fee: 9223372036854775n, poolTypeConfig: FULL_RANGE_POOL_TYPE_CONFIG });
const MEV_CAPTURE_CONFIG = compressed({ extension: MEV_CAPTURE_ADDRESS, fee: 1844674407370954n, poolTypeConfig: concentratedPoolTypeConfig(1000) });

interface PoolConfigWithName {
    poolConfig: Hex,
    asUnknownExtension: boolean,
    extensionName: string,
}

const NATIVE_ERC20_CONFIGS: PoolConfigWithName[] = [
    {
        poolConfig: CONCENTRATED_CONFIG,
        asUnknownExtension: false,
        extensionName: "base",
    },
    {
        poolConfig: ORACLE_CONFIG,
        asUnknownExtension: false,
        extensionName: "oracle",
    },
    {
        poolConfig: TWAMM_CONFIG,
        asUnknownExtension: false,
        extensionName: "twamm",
    },
    {
        poolConfig: MEV_CAPTURE_CONFIG,
        asUnknownExtension: false,
        extensionName: "mevCapture",
    },
    {
        poolConfig: STABLESWAP_CONFIG,
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
        data: await generateCalldata({
            chainId: CHAIN_ID,
            specifiedToken: NATIVE_TOKEN_ADDRESS,
            recipient: RECIPIENT,
            calculatedAmountThreshold: parseEther("1"),
            integrationFee: INTEGRATION_FEE,
            multiHops: [
                {
                    specifiedAmount: parseEther("1"),
                    hops: [
                        {
                            type: "swap",
                            poolKey: {
                                token0: NATIVE_TOKEN_ADDRESS,
                                token1: ERC20_FIRST_ADDRESS,
                                config: TWAMM_CONFIG,
                            }
                        },
                        {
                            type: "swap",
                            poolKey: {
                                token0: ERC20_FIRST_ADDRESS,
                                token1: ERC20_SECOND_ADDRESS,
                                config: FULL_RANGE_CONFIG,
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
                                token0: NATIVE_TOKEN_ADDRESS,
                                token1: ERC20_SECOND_ADDRESS,
                                config: STABLESWAP_CONFIG,
                            },
                        }
                    ],
                },
            ]
        }),
        specifiedToken: NATIVE_TOKEN_ADDRESS,
        calculatedToken: ERC20_SECOND_ADDRESS,
        isExactOut: false,
        delegatecall: true,
        totalSpecified: parseEther("1.5"),
        recipient: RECIPIENT,
        integrator: INTEGRATION_FEE.integrator,
        poolKeys: [{
            token0: NATIVE_TOKEN_ADDRESS,
            token1: ERC20_FIRST_ADDRESS,
            config: TWAMM_CONFIG,
        }, {
            token0: ERC20_FIRST_ADDRESS,
            token1: ERC20_SECOND_ADDRESS,
            config: FULL_RANGE_CONFIG,
        }, {
            token0: NATIVE_TOKEN_ADDRESS,
            token1: ERC20_SECOND_ADDRESS,
            config: STABLESWAP_CONFIG,
        }],
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

                            // Pool swaps
                            for (const { poolConfig, asUnknownExtension, extensionName } of NATIVE_ERC20_CONFIGS) {
                                // TODO Not true anymore
                                // Ideally we'd also have a loop over isToken1 here but ETH/USDC is currently the only pair
                                // that has pools of every extension type

                                // These two decisions don't depend on each other
                                const tokenInNative = asLastInMultiHop;

                                const [specifiedToken, firstCalculatedToken]: [Address, Address] = tokenInNative === isExactOut
                                    ? [
                                        ERC20_FIRST_ADDRESS,
                                        NATIVE_TOKEN_ADDRESS,
                                    ]
                                    : [
                                        NATIVE_TOKEN_ADDRESS,
                                        ERC20_FIRST_ADDRESS,
                                    ];

                                let hops, calculatedToken: Address;

                                if (asLastInMultiHop) {
                                    calculatedToken = firstCalculatedToken;
                                    hops = [
                                        {
                                            type: "swap" as const,
                                            poolKey: {
                                                token0: NATIVE_TOKEN_ADDRESS,
                                                token1: ERC20_FIRST_ADDRESS,
                                                config: poolConfig,
                                            },
                                            sqrtRatioLimit: getSqrtRatioLimit(specifiedToken, firstCalculatedToken),
                                        }
                                    ];
                                } else {
                                    const secondCalculatedToken = tokenInNative === isExactOut
                                        ? ERC20_FIRST_ADDRESS
                                        : NATIVE_TOKEN_ADDRESS;

                                    calculatedToken = secondCalculatedToken;

                                    hops = [
                                        {
                                            type: "swap" as const,
                                            poolKey: {
                                                token0: NATIVE_TOKEN_ADDRESS,
                                                token1: ERC20_FIRST_ADDRESS,
                                                config: poolConfig,
                                            },
                                            sqrtRatioLimit: getSqrtRatioLimit(specifiedToken, firstCalculatedToken),
                                        },
                                        {
                                            type: "swap" as const,
                                            poolKey: {
                                                token0: NATIVE_TOKEN_ADDRESS,
                                                token1: ERC20_FIRST_ADDRESS,
                                                config: CONCENTRATED_CONFIG,
                                            },
                                        },
                                    ];
                                }

                                const calldata = await generateCalldataImpl({
                                    chainId: CHAIN_ID,
                                    specifiedToken,
                                    recipient,
                                    multiHops: [
                                        {
                                            specifiedAmount: isExactOut ? -SPECIFIED_AMOUNT : SPECIFIED_AMOUNT,
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
                                    totalSpecified: SPECIFIED_AMOUNT,
                                    recipient: recipient ?? zeroAddress,
                                    integrator: integrationFee?.integrator ?? zeroAddress,
                                    poolKeys: hops.map(hop => hop.poolKey),
                                    name: getTestcaseName(`${extensionName}Extension`, tokenInNative ? "Native" : "Erc20"),
                                } as const);

                                if (typeof integrationFee !== "undefined" || delegatecall || typeof recipient === "string") {
                                    break;
                                }
                            }

                            // Wrapped tokens
                            {
                                // sqrtRatioLimit is irrelevant when only a token wrap/unwrap happens
                                if (withSqrtRatioLimit && asLastInMultiHop) {
                                    continue;
                                }

                                for (const tokenInUnderlying of [true, false]) {
                                    const [specifiedToken, firstCalculatedToken]: [Address, Address] = tokenInUnderlying === isExactOut
                                        ? [
                                            TOKEN_WRAPPER_ADDRESS,
                                            ERC20_FIRST_ADDRESS,
                                        ]
                                        : [
                                            ERC20_FIRST_ADDRESS,
                                            TOKEN_WRAPPER_ADDRESS,
                                        ];

                                    let hops: Hop[], calculatedToken: Address;

                                    if (asLastInMultiHop) {
                                        calculatedToken = firstCalculatedToken;
                                        hops = [
                                            {
                                                type: "wrappedToken",
                                                underlying: ERC20_FIRST_ADDRESS,
                                                wrapped: TOKEN_WRAPPER_ADDRESS,
                                            }
                                        ];
                                    } else {
                                        const secondCalculatedToken = tokenInUnderlying === isExactOut
                                            ? TOKEN_WRAPPER_ADDRESS
                                            : ERC20_FIRST_ADDRESS;

                                        calculatedToken = secondCalculatedToken;

                                        hops = [
                                            {
                                                type: "wrappedToken",
                                                underlying: ERC20_FIRST_ADDRESS,
                                                wrapped: TOKEN_WRAPPER_ADDRESS,
                                            },
                                            {
                                                type: "swap",
                                                poolKey: {
                                                    token0: ERC20_FIRST_ADDRESS,
                                                    token1: TOKEN_WRAPPER_ADDRESS,
                                                    config: compressed({
                                                        extension: MEV_CAPTURE_ADDRESS,
                                                        fee: 18446744073709552n,
                                                        poolTypeConfig: concentratedPoolTypeConfig(4988),
                                                    }),
                                                },
                                                sqrtRatioLimit: getSqrtRatioLimit(firstCalculatedToken, secondCalculatedToken),
                                            },
                                        ];
                                    }

                                    const calldata = await generateCalldataImpl({
                                        chainId: CHAIN_ID,
                                        specifiedToken,
                                        recipient,
                                        multiHops: [
                                            {
                                                specifiedAmount: isExactOut ? -SPECIFIED_AMOUNT : SPECIFIED_AMOUNT,
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
                                        totalSpecified: SPECIFIED_AMOUNT,
                                        recipient: recipient ?? zeroAddress,
                                        integrator: integrationFee?.integrator ?? zeroAddress,
                                        poolKeys: hops.flatMap(hop => {
                                            if (hop.type === "swap") {
                                                return [hop.poolKey];
                                            } else {
                                                return [];
                                            }
                                        }),
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
                }
            }
        }
    }
}

const slippageCheckFailedCases: SdkCases["slippageCheckFailed"] = [
    {
        calculatedAmountThreshold: maxUint256,
        isExactOut: false,
        data: await generateCalldata({
            chainId: CHAIN_ID,
            specifiedToken: NATIVE_TOKEN_ADDRESS,
            multiHops: [{
                specifiedAmount: SPECIFIED_AMOUNT,
                hops: [
                    {
                        type: "swap",
                        poolKey: {
                            token0: NATIVE_TOKEN_ADDRESS,
                            token1: ERC20_FIRST_ADDRESS,
                            config: CONCENTRATED_CONFIG,
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
        data: await generateCalldata({
            chainId: CHAIN_ID,
            specifiedToken: NATIVE_TOKEN_ADDRESS,
            multiHops: [{
                specifiedAmount: -SPECIFIED_AMOUNT,
                hops: [
                    {
                        type: "swap",
                        poolKey: {
                            token0: NATIVE_TOKEN_ADDRESS,
                            token1: ERC20_FIRST_ADDRESS,
                            config: CONCENTRATED_CONFIG,
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
        data: await generateCalldata({
            chainId: CHAIN_ID,
            specifiedToken: ERC20_FIRST_ADDRESS,
            multiHops: [
                {
                    specifiedAmount: -SPECIFIED_AMOUNT,
                    hops: [
                        {
                            type: "swap",
                            poolKey: {
                                token0: NATIVE_TOKEN_ADDRESS,
                                token1: ERC20_FIRST_ADDRESS,
                                config: CONCENTRATED_CONFIG,
                            }
                        },
                    ],
                },
            ],
        }),
    },
}]));
