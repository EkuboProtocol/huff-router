import { Address, encodeAbiParameters, getAbiItem, hexToBigInt, parseEther, parseUnits, zeroAddress } from "viem";
import { hyperRouterTestAbi } from "./abi";
import { MEV_RESIST_ADDRESS, TWAMM_ADDRESS } from "../src/extensions";
import { generateCalldata, IntegrationFee, PoolConfig, Swap } from "../src";
import { generateCalldataImpl, MAX_SQRT_RATIO, MIN_SQRT_RATIO } from "../src/impl";
import type { ElementOf, Writable } from "ts-essentials";
import { ETH_ADDRESS, INTEGRATOR, ORACLE_CONFIG, USDC_ADDRESS, USDT_ADDRESS } from "./shared";

const ETH_SPECIFIED = parseEther("1");
const USDC_SPECIFIED = parseUnits("3000", 6);

const RECIPIENT: Address = "0x46b7916bCEC93409d18a4771C43dCCdddD62585E";
const INTEGRATION_FEE: IntegrationFee = {
    integrator: INTEGRATOR,
    fee: 32768, // 50%
};

const ETH_USDC_2_BIPS = { extension: zeroAddress, fee: 3689348814741910n, tickSpacing: 4990 };
const ETH_USDC_5_BIPS = { extension: zeroAddress, fee: 9223372036854775n, tickSpacing: 1000 };
const ETH_USDT = { extension: zeroAddress, fee: 3689348814741910n, tickSpacing: 4990 }
const USDC_USDT = { extension: zeroAddress, fee: 92233720368547n, tickSpacing: 50 };
const TWAMM_ETH_USDC = { extension: TWAMM_ADDRESS, fee: 9223372036854775n, tickSpacing: 0 };
const MEV_RESIST_ETH_USDC: PoolConfig = { extension: MEV_RESIST_ADDRESS, fee: 1844674407370954n, tickSpacing: 1000 };

interface PoolConfigWithName {
    poolConfig: PoolConfig,
    asUnknownExtension: boolean,
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

const cases: Writable<ElementOf<Parameters<typeof encodeAbiParameters<typeof inputs>>[1]>> = [
    {
        data: generateCalldata({
            specifiedToken: ETH_ADDRESS,
            recipient: RECIPIENT,
            calculatedAmountThreshold: parseUnits("2000", 6),
            integrationFee: INTEGRATION_FEE,
            multiHopSwaps: [
                {
                    specifiedAmount: parseEther("1"),
                    swaps: [
                        {
                            poolConfig: TWAMM_ETH_USDC,
                            calculatedToken: USDC_ADDRESS,
                        },
                        {
                            poolConfig: USDC_USDT,
                            calculatedToken: USDT_ADDRESS,
                            skipAhead: 10,
                            sqrtRatioLimit: MIN_SQRT_RATIO,
                        }
                    ],
                },
                {
                    specifiedAmount: parseEther("0.5"),
                    swaps: [
                        {
                            poolConfig: ETH_USDT,
                            calculatedToken: USDT_ADDRESS,
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
                    for (const { poolConfig, asUnknownExtension, extensionName } of ETH_USDC_CONFIGS) {
                        for (const asLastSwapInMultiHop of [true, false]) {
                            // These two decisions don't depend on each other
                            const tokenInNative = asLastSwapInMultiHop;

                            for (const asUnknownToken of [false, true]) {
                                // For the last swaps the calculated tokens aren't encoded anyway
                                if (asUnknownToken && asLastSwapInMultiHop) {
                                    continue;
                                }

                                // Ideally we'd also have a loop over isToken1 here but ETH/USDC is currently the only pair
                                // that has pools of every extension type

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

                                function getSqrtRatioLimit(calculatedToken: Address) {
                                    return withSqrtRatioLimit
                                        ? (hexToBigInt(specifiedToken) > hexToBigInt(calculatedToken) === isExactOut)
                                            ? MIN_SQRT_RATIO
                                            : MAX_SQRT_RATIO
                                        : undefined;
                                }

                                let swaps: Swap[], calculatedToken: Address;

                                if (asLastSwapInMultiHop) {
                                    calculatedToken = firstCalculatedToken;
                                    swaps = [
                                        {
                                            calculatedToken: firstCalculatedToken,
                                            poolConfig,
                                            sqrtRatioLimit: getSqrtRatioLimit(firstCalculatedToken),
                                        }
                                    ];
                                } else {
                                    const secondCalculatedToken = tokenInNative === isExactOut
                                        ? USDC_ADDRESS
                                        : ETH_ADDRESS;

                                    calculatedToken = secondCalculatedToken;

                                    swaps = [
                                        {
                                            calculatedToken: firstCalculatedToken,
                                            poolConfig,
                                            sqrtRatioLimit: getSqrtRatioLimit(firstCalculatedToken),
                                        },
                                        {
                                            calculatedToken: secondCalculatedToken,
                                            poolConfig: ETH_USDC_5_BIPS,
                                        },
                                    ];
                                }

                                const calldata = generateCalldataImpl({
                                    specifiedToken,
                                    recipient,
                                    multiHopSwaps: [
                                        {
                                            specifiedAmount: isExactOut ? -specifiedAmount : specifiedAmount,
                                            swaps,
                                        }
                                    ],
                                    integrationFee,
                                }, {
                                    forceUnknownExtension: asUnknownExtension,
                                    forceUnknownToken: asUnknownToken,
                                });

                                const name = `\
${typeof recipient === "undefined" ? "default" : "custom"}Recipient_\
${delegatecall ? "delegatecall" : "call"}_\
exact${isExactOut ? "Out" : "In"}_\
${typeof integrationFee === "undefined" ? "without" : "with"}IntegrationFee_\
${withSqrtRatioLimit ? "with" : "without"}SqrtRatioLimit_\
${extensionName}Extension_\
${asLastSwapInMultiHop ? "last" : "notLast"}Swap_\
tokenIn${tokenInNative ? "Native" : "Erc20"}_\
${asUnknownToken ? "unknown" : "known"}Tokens`;

                                cases.push({
                                    data: calldata,
                                    specifiedToken,
                                    calculatedToken,
                                    isExactOut,
                                    delegatecall,
                                    totalSpecified: specifiedAmount,
                                    recipient: recipient ?? zeroAddress,
                                    integrator: integrationFee?.integrator ?? zeroAddress,
                                    name,
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

console.log(encodeAbiParameters(inputs, [cases]));
