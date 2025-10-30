import { ByteArray, bytesToHex, concatBytes, getAddress, Hex, hexToBigInt, hexToBytes, maxInt128, maxUint16, maxUint256, maxUint32, maxUint64, maxUint8, minInt128, numberToBytes, numberToHex, padBytes, padHex, size, sliceHex, toBytes, zeroAddress } from "viem";
import TOKENS from "../../tokens/ethereum.json";
import { ORACLE_ADDRESS, TWAMM_ADDRESS, MEV_RESIST_ADDRESS } from "./extensions";
import { Hop, Parameters, Swap } from ".";

const TWO_POW_62 = 2n ** 62n;
const TWO_POW_256 = maxUint256 + 1n;

const SQRT_RATIO_LIMIT_BYTES = 12;
const FEE_SHARE_BYTES = 2;

const NOT_BIT_MASK = 0x3fffffffffffffffffffffffn;

const UNKNOWN_TOKEN = 0xff;

export const MAX_MULTIHOP_LENGTH = Number(maxUint8) + 1;
export const MAX_HOP_LENGTH = Number(maxUint8) + 1;
export const MIN_SPECIFIED_AMOUNT = minInt128;
export const MAX_SPECIFIED_AMOUNT = maxInt128;
export const MIN_SQRT_RATIO = 4611797791050542631n;
export const MAX_SQRT_RATIO = 79227682466138141934206691491n;
export const MAX_SKIP_AHEAD = Number(maxUint8);
export const MIN_CALCULATED_AMOUNT_THRESHOLD = -maxUint256;
export const MAX_CALCULATED_AMOUNT_THRESHOLD = maxUint256;
export const MAX_INTEGRATION_FEE = Number(maxUint16);

export const ERROR_MULTIHOP_SWAPS_LENGTH = `need between one and ${MAX_MULTIHOP_LENGTH} multi-hops`;
export const ERROR_HOPS_LENGTH = `each multi-hop needs to consist of at least one and at most ${MAX_HOP_LENGTH} hops`;
export const ERROR_SPECIFIED_AMOUNT_RANGE = "specified amounts need to fit into int128";
export const ERROR_SPECIFIED_AMOUNT_MIXED_SIGN = "mixed exact-out / exact-in multi-hops";
export const ERROR_INVALID_SQRT_RATIO_LIMIT = "invalid sqrtRatioLimit";
export const ERROR_SKIP_AHEAD_RANGE = "skipAhead must fit into uint8";
export const ERROR_CALCULATED_TOKEN_MISMATCH = "last swaps of each multi-hop must end at the same calculated token";
export const ERROR_CALCULATED_AMOUNT_THRESHOLD_SIGN = "calculatedAmountThreshold sign and specified amount signs have to be equivalent";
export const ERROR_CALCULATED_AMOUNT_THRESHOLD_RANGE = "absolute value of calculatedAmountThreshold can't exceed maximum uint256 value";
export const ERROR_TOKEN0_TOKEN1_ORDER = "token0 and token1 are not ordered ascendingly";
export const ERROR_HOP_CONNECTION = "output of hop can't be used in next hop";
export const ERROR_UNDERLYING_EQ_WRAPPED = "underlying token must be different from wrapped token";

interface TestParameters {
    forceUnknownExtension: boolean;
    forceUnknownToken: boolean;
}

export function generateCalldataImpl(
    params: Parameters,
    { forceUnknownExtension, forceUnknownToken }: TestParameters = { forceUnknownExtension: false, forceUnknownToken: false },
): Hex {
    const { multiHops, recipient, calculatedAmountThreshold, integrationFee } = params;
    const specifiedToken = getAddress(padHex(params.specifiedToken, { size: 20 }));

    if (multiHops.length < 1 || multiHops.length > MAX_MULTIHOP_LENGTH) {
        throw new Error(ERROR_MULTIHOP_SWAPS_LENGTH);
    }

    let maxSpecified = 0n;
    let withSqrtRatioLimit = false;
    let isExactOut: boolean | null = null;

    for (const { specifiedAmount, hops } of multiHops) {
        if (hops.length < 1 || hops.length > 256) {
            throw new Error(ERROR_HOPS_LENGTH);
        }

        const specifiedAmountAbs = abs(specifiedAmount);

        if (maxSpecified < specifiedAmountAbs) {
            maxSpecified = specifiedAmountAbs;
        }

        if (specifiedAmount !== 0n) {
            if (specifiedAmount < MIN_SPECIFIED_AMOUNT || specifiedAmount > MAX_SPECIFIED_AMOUNT) {
                throw new Error(ERROR_SPECIFIED_AMOUNT_RANGE);
            }

            const isMultiHopSwapExactOut = specifiedAmount < 0n;

            if (typeof isExactOut === "boolean" && isExactOut !== isMultiHopSwapExactOut) {
                throw new Error(ERROR_SPECIFIED_AMOUNT_MIXED_SIGN);
            }

            isExactOut = isMultiHopSwapExactOut;
        }

        for (let i = 0; i < hops.length; i++) {
            const hop = hops[i];

            if (hop.type === "swap") {
                const { sqrtRatioLimit, skipAhead } = hop;
                const swapWithSqrtRatioLimit = typeof sqrtRatioLimit !== "undefined";

                if (swapWithSqrtRatioLimit && (sqrtRatioLimit < MIN_SQRT_RATIO || sqrtRatioLimit > MAX_SQRT_RATIO || (sqrtRatioLimit & NOT_BIT_MASK) < TWO_POW_62)) {
                    throw new Error(ERROR_INVALID_SQRT_RATIO_LIMIT);
                }

                if (typeof skipAhead === "number" && (skipAhead < 0 || skipAhead > MAX_SKIP_AHEAD)) {
                    throw new Error(ERROR_SKIP_AHEAD_RANGE);
                }

                withSqrtRatioLimit ||= swapWithSqrtRatioLimit;
            }
        }
    }

    let calculatedAmountThresholdUnsigned;

    if (typeof calculatedAmountThreshold === "undefined") {
        calculatedAmountThresholdUnsigned = 0n;
    } else {
        const isExactOutThreshold = calculatedAmountThreshold < 0n;

        if (typeof isExactOut === "boolean" && isExactOut !== isExactOutThreshold) {
            throw new Error(ERROR_CALCULATED_AMOUNT_THRESHOLD_SIGN);
        }

        const calculatedAmountThresholdAbs = isExactOutThreshold ? -calculatedAmountThreshold : calculatedAmountThreshold;

        if (calculatedAmountThresholdAbs > maxUint256) {
            throw new Error(ERROR_CALCULATED_AMOUNT_THRESHOLD_RANGE);
        }

        if (isExactOutThreshold) {
            calculatedAmountThresholdUnsigned = (calculatedAmountThresholdAbs + 1n) % TWO_POW_256;
        } else {
            calculatedAmountThresholdUnsigned = calculatedAmountThresholdAbs;
        }
    }

    isExactOut ??= (calculatedAmountThreshold ?? 0n) < 0n;

    const withRecipient = typeof recipient !== "undefined";
    const specifiedAmountBytes = maxSpecified === 0n ? 0 : size(numberToHex(maxSpecified));
    const withIntegrationFee = typeof integrationFee !== "undefined" && integrationFee.fee !== 0;

    let calculatedTokenBig: bigint | null = null;
    const calldata = [];

    for (const { specifiedAmount, hops } of multiHops) {
        calldata.push(
            padBytes(specifiedAmount === 0n ? new Uint8Array() : numberToBytes(abs(specifiedAmount)), { size: specifiedAmountBytes }),
            numberToBytes(hops.length - 1),
        );

        let nextSpecifiedToken = hexToBigInt(specifiedToken);

        for (let i = 0; i < hops.length; i++) {
            const hop = hops[i];

            function maybePushHopCalculatedToken(hopCalculatedToken: Hex) {
                if (i !== hops.length - 1) {
                    const swapCalculatedTokenId = forceUnknownToken ? null : tokenId(hopCalculatedToken);

                    calldata.push(new Uint8Array([swapCalculatedTokenId ?? UNKNOWN_TOKEN]));

                    if (swapCalculatedTokenId === null) {
                        calldata.push(hexToBytes(hopCalculatedToken));
                    }
                }
            }

            if (hop.type === "swap") {
                const { poolKey, sqrtRatioLimit: sqrtRatioLimitOpt } = hop;

                const [token0, token1] = [padHex(poolKey.token0, { size: 20 }), padHex(poolKey.token1, { size: 20 })];
                const [token0Big, token1Big] = [hexToBigInt(token0), hexToBigInt(token1)];
                const config = padHex(poolKey.config);

                if (token0Big >= token1Big) {
                    throw new Error(ERROR_TOKEN0_TOKEN1_ORDER);
                }

                let hopCalculatedToken, isToken1;

                if (token0Big === nextSpecifiedToken) {
                    [isToken1, hopCalculatedToken, nextSpecifiedToken] = [
                        false, getAddress(token1), token1Big
                    ];
                } else if (token1Big === nextSpecifiedToken) {
                    [isToken1, hopCalculatedToken, nextSpecifiedToken] = [
                        true, getAddress(token0), token0Big
                    ];
                } else {
                    throw new Error(ERROR_HOP_CONNECTION);
                }

                const [
                    extension,
                    fee,
                    tickSpacing
                ] = [
                        getAddress(sliceHex(config, 0, 20)),
                        toBytes(sliceHex(config, 20, 28)),
                        toBytes(sliceHex(config, 28, 32)),
                    ];
                const skipAhead = hop.skipAhead ?? 0;

                function unknownExtension() {
                    calldata.push(
                        new Uint8Array([
                            4,
                            skipAhead,
                        ]),
                        hexToBytes(config),
                    );
                }

                if (forceUnknownExtension) {
                    unknownExtension()
                } else {
                    switch (extension) {
                        case zeroAddress:
                            calldata.push(
                                new Uint8Array([
                                    0,
                                    skipAhead,
                                ]),
                                fee,
                                tickSpacing,
                            );
                            break;
                        case ORACLE_ADDRESS:
                            calldata.push(new Uint8Array([1]));
                            break;
                        case TWAMM_ADDRESS:
                            calldata.push(
                                new Uint8Array([2]),
                                fee,
                            );
                            break;
                        case MEV_RESIST_ADDRESS:
                            calldata.push(
                                new Uint8Array([
                                    3,
                                    skipAhead,
                                ]),
                                fee,
                                tickSpacing,
                            );
                            break;
                        default:
                            unknownExtension();
                    }
                }

                maybePushHopCalculatedToken(hopCalculatedToken);

                if (withSqrtRatioLimit) {
                    let sqrtRatioLimit;

                    if (typeof sqrtRatioLimitOpt === "undefined") {
                        const isPriceIncreasing = isToken1 !== isExactOut;

                        sqrtRatioLimit = isPriceIncreasing ? MAX_SQRT_RATIO : MIN_SQRT_RATIO;
                    } else {
                        sqrtRatioLimit = sqrtRatioLimitOpt;
                    }

                    calldata.push(numberToBytes(sqrtRatioLimit, { size: SQRT_RATIO_LIMIT_BYTES }));
                }
            } else if (hop.type === "wrappedToken") {
                const [underlying, wrapped] = [padHex(hop.underlying, { size: 20 }), padHex(hop.wrapped, { size: 20 })];
                const [underlyingBig, wrappedBig] = [hexToBigInt(underlying), hexToBigInt(wrapped)];

                if (underlyingBig === wrappedBig) {
                    throw new Error(ERROR_UNDERLYING_EQ_WRAPPED);
                }

                let hopCalculatedToken, unwrap;

                if (underlyingBig === nextSpecifiedToken) {
                    [hopCalculatedToken, nextSpecifiedToken, unwrap] = [
                        getAddress(wrapped), wrappedBig, isExactOut
                    ];
                } else if (wrappedBig === nextSpecifiedToken) {
                    [hopCalculatedToken, nextSpecifiedToken, unwrap] = [
                        getAddress(underlying), underlyingBig, !isExactOut
                    ];
                } else {
                    throw new Error(ERROR_HOP_CONNECTION);
                }

                calldata.push(
                    new Uint8Array([
                        5,
                        Number(unwrap),
                    ]),
                );

                maybePushHopCalculatedToken(hopCalculatedToken);
            } else {
                throw new Error("unrecognized hop type");
            }
        }

        if (calculatedTokenBig === null) {
            calculatedTokenBig = nextSpecifiedToken;
        } else if (calculatedTokenBig !== nextSpecifiedToken) {
            throw new Error(ERROR_CALCULATED_TOKEN_MISMATCH);
        }
    }

    if (withIntegrationFee) {
        calldata.push(
            numberToBytes(integrationFee.fee, { size: FEE_SHARE_BYTES }),
            hexToBytes(getAddress(padHex(integrationFee.integrator, { size: 20 }))),
        );
    }

    if (withRecipient) {
        calldata.push(hexToBytes(getAddress(padHex(recipient, { size: 20 }))));
    }

    const calculatedToken = getAddress(numberToHex(
        calculatedTokenBig!, // Holds true because we enforce at least one multiHopSwap and at least one swap per multiHopSwap
        { size: 20 },
    ));

    const calculatedAmountThresholdBin = calculatedAmountThresholdUnsigned === 0n ? new Uint8Array() : numberToBytes(calculatedAmountThresholdUnsigned);
    const [specifiedTokenId, calculatedTokenId] = forceUnknownToken ? [null, null] : [tokenId(specifiedToken), tokenId(calculatedToken)];

    let headerCalldata: ByteArray[] = [
        new Uint8Array([
            Number(withRecipient),
            specifiedAmountBytes,
            size(calculatedAmountThresholdBin),
            specifiedTokenId ?? UNKNOWN_TOKEN,
            calculatedTokenId ?? UNKNOWN_TOKEN,
            multiHops.length - 1,
            Number(withIntegrationFee),
            (Number(withSqrtRatioLimit) << 1) + Number(isExactOut),
        ]),
        calculatedAmountThresholdBin,
    ];

    if (specifiedTokenId === null) {
        headerCalldata.push(hexToBytes(specifiedToken));
    }

    if (calculatedTokenId === null) {
        headerCalldata.push(hexToBytes(calculatedToken));
    }

    return bytesToHex(concatBytes([
        concatBytes(headerCalldata),
        concatBytes(calldata),
    ]));
}

function abs(big: bigint): bigint {
    return big < 0n ? -big : big;
}

function tokenId(address: string): number | null {
    const idx = TOKENS.findIndex(token => token.address === address);
    return idx === -1 ? null : idx;
}