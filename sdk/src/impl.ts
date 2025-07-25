import { Address, ByteArray, bytesToHex, concatBytes, getAddress, Hex, hexToBigInt, hexToBytes, maxInt128, maxUint256, minInt128, numberToBytes, numberToHex, pad, padBytes, padHex, size, toBytes, toHex, zeroAddress } from "viem";
import TOKENS from "../../tokens/ethereum.json";
import { ORACLE_ADDRESS, TWAMM_ADDRESS, MEV_RESIST_ADDRESS } from "./extensions";
import { Parameters } from ".";

const TWO_POW_62 = 2n ** 62n;
const TWO_POW_256 = maxUint256 + 1n;

const FEE_BYTES = 8;
const TICK_SPACING_BYTES = 4;
const SQRT_RATIO_LIMIT_BYTES = 12;
const FEE_SHARE_BYTES = 2;

export const MIN_SQRT_RATIO = 4611797791050542631n;
export const MAX_SQRT_RATIO = 79227682466138141934206691491n;
const NOT_BIT_MASK = 0x3fffffffffffffffffffffffn;

const UNKNOWN_TOKEN = 0xff;

interface TestParameters {
    forceUnknownExtension: boolean;
    forceUnknownToken: boolean;
}

export function generateCalldataImpl(
    params: Parameters,
    { forceUnknownExtension, forceUnknownToken }: TestParameters = { forceUnknownExtension: false, forceUnknownToken: false },
): Hex {
    const { multiHopSwaps, recipient, calculatedAmountThreshold, integrationFee } = params;
    const specifiedToken = getAddress(params.specifiedToken);

    if (multiHopSwaps.length < 1 || multiHopSwaps.length > 256) {
        throw new Error("need between one and 256 multiHopSwaps");
    }

    let maxSpecified = 0n;
    let withSqrtRatioLimit = false;
    let isExactOut: boolean | null = null;
    let calculatedToken: Address | null = null;

    for (const { specifiedAmount, swaps } of multiHopSwaps) {
        if (swaps.length < 1 || swaps.length > 256) {
            throw new Error("each multiHopSwap needs to consist of at least one and at most 256 swaps");
        }

        const specifiedAmountAbs = abs(specifiedAmount);

        if (maxSpecified < specifiedAmountAbs) {
            maxSpecified = specifiedAmountAbs;
        }

        if (specifiedAmount !== 0n) {
            if (specifiedAmount < minInt128 || specifiedAmount > maxInt128) {
                throw new Error("specified amounts need to fit into int128");
            }

            const isMultiHopSwapExactOut = specifiedAmount < 0n;

            if (typeof isExactOut === "boolean" && isExactOut !== isMultiHopSwapExactOut) {
                throw new Error("mixed exact-out / exact-in multiHopSwaps");
            }

            isExactOut = isMultiHopSwapExactOut;
        }

        for (let i = 0; i < swaps.length; i++) {
            const swap = swaps[i];
            const { sqrtRatioLimit, skipAhead, calculatedToken: swapCalculatedToken } = swap;
            const swapWithSqrtRatioLimit = typeof sqrtRatioLimit !== "undefined";

            if (swapWithSqrtRatioLimit && (sqrtRatioLimit < MIN_SQRT_RATIO || sqrtRatioLimit > MAX_SQRT_RATIO || (sqrtRatioLimit & NOT_BIT_MASK) < TWO_POW_62)) {
                throw new Error("invalid sqrtRatioLimit");
            }

            if (typeof skipAhead === "number" && skipAhead > 255) {
                throw new Error("skipAhead must fit into uint8");
            }

            if (i == swaps.length - 1) {
                const checksummedSwapCalculatedToken = getAddress(swapCalculatedToken);

                if (calculatedToken === null) {
                    calculatedToken = checksummedSwapCalculatedToken;
                } else if (calculatedToken !== checksummedSwapCalculatedToken) {
                    throw new Error("last swaps of each multiHopSwap must end at the same calculated token");
                }
            }

            withSqrtRatioLimit ||= swapWithSqrtRatioLimit;
        }
    }

    let calculatedAmountThresholdUnsigned;

    if (typeof calculatedAmountThreshold === "undefined") {
        calculatedAmountThresholdUnsigned = 0n;
    } else {
        const isExactOutThreshold = calculatedAmountThreshold < 0n;

        if (typeof isExactOut === "boolean" && isExactOut !== isExactOutThreshold) {
            throw new Error("calculatedAmountThreshold sign and specified amount signs have to be equivalent");
        }

        const calculatedAmountThresholdAbs = isExactOutThreshold ? -calculatedAmountThreshold : calculatedAmountThreshold;

        if (calculatedAmountThresholdAbs > maxUint256) {
            throw new Error("absolute value of calculatedAmountThreshold can't exceed maximum uint256 value");
        }

        if (isExactOutThreshold) {
            calculatedAmountThresholdUnsigned = (calculatedAmountThresholdAbs + 1n) % TWO_POW_256;
        } else {
            calculatedAmountThresholdUnsigned = calculatedAmountThresholdAbs;
        }
    }

    // Holds true because we enforce at least one multiHopSwap and at least one swap per multiHopSwap
    calculatedToken = calculatedToken!;

    isExactOut ??= (calculatedAmountThreshold ?? 0n) < 0n;

    const withRecipient = typeof recipient !== "undefined";
    const specifiedAmountBytes = maxSpecified === 0n ? 0 : size(numberToHex(maxSpecified));
    const calculatedAmountThresholdBin = calculatedAmountThresholdUnsigned === 0n ? new Uint8Array() : numberToBytes(calculatedAmountThresholdUnsigned);
    const [specifiedTokenId, calculatedTokenId] = forceUnknownToken ? [null, null] : [tokenId(specifiedToken), tokenId(calculatedToken)];
    const withIntegrationFee = typeof integrationFee !== "undefined" && integrationFee.fee !== 0;

    let calldata: ByteArray[] = [
        new Uint8Array([
            Number(withRecipient),
            specifiedAmountBytes,
            size(calculatedAmountThresholdBin),
            specifiedTokenId ?? UNKNOWN_TOKEN,
            calculatedTokenId ?? UNKNOWN_TOKEN,
            multiHopSwaps.length - 1,
            Number(withIntegrationFee),
            (Number(withSqrtRatioLimit) << 1) + Number(isExactOut),
        ]),
        calculatedAmountThresholdBin,
    ];

    if (specifiedTokenId === null) {
        calldata.push(hexToBytes(specifiedToken));
    }

    if (calculatedTokenId === null) {
        calldata.push(hexToBytes(calculatedToken));
    }

    for (const { specifiedAmount, swaps } of multiHopSwaps) {
        calldata.push(
            padBytes(specifiedAmount === 0n ? new Uint8Array() : numberToBytes(abs(specifiedAmount)), { size: specifiedAmountBytes }),
            numberToBytes(swaps.length - 1),
        );

        let nextSpecifiedToken = hexToBigInt(specifiedToken);

        for (let i = 0; i < swaps.length; i++) {
            const swap = swaps[i];
            const { poolConfig, sqrtRatioLimit: sqrtRatioLimitOpt } = swap;
            const { fee, tickSpacing } = poolConfig;
            const swapCalculatedToken = getAddress(swap.calculatedToken);

            const extension = getAddress(poolConfig.extension);
            const skipAhead = swap.skipAhead ?? 0;

            function unknownExtension() {
                calldata.push(
                    new Uint8Array([
                        4,
                        skipAhead,
                    ]),
                    hexToBytes(extension),
                    numberToBytes(fee, { size: FEE_BYTES }),
                    numberToBytes(tickSpacing, { size: TICK_SPACING_BYTES }),
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
                            numberToBytes(fee, { size: FEE_BYTES }),
                            numberToBytes(tickSpacing, { size: TICK_SPACING_BYTES }),
                        );
                        break;
                    case ORACLE_ADDRESS:
                        calldata.push(new Uint8Array([1]));
                        break;
                    case TWAMM_ADDRESS:
                        calldata.push(
                            new Uint8Array([2]),
                            numberToBytes(fee, { size: FEE_BYTES }),
                        );
                        break;
                    case MEV_RESIST_ADDRESS:
                        calldata.push(
                            new Uint8Array([
                                3,
                                skipAhead,
                            ]),
                            numberToBytes(fee, { size: FEE_BYTES }),
                            numberToBytes(tickSpacing, { size: TICK_SPACING_BYTES }),
                        );
                        break;
                    default:
                        unknownExtension();
                }
            }

            if (i !== swaps.length - 1) {
                const swapCalculatedTokenId = forceUnknownToken ? null : tokenId(swapCalculatedToken);

                calldata.push(new Uint8Array([swapCalculatedTokenId ?? UNKNOWN_TOKEN]));

                if (swapCalculatedTokenId === null) {
                    calldata.push(hexToBytes(swapCalculatedToken));
                }
            }

            const swapCalculatedTokenBig = hexToBigInt(swapCalculatedToken);

            if (withSqrtRatioLimit) {
                let sqrtRatioLimit;

                if (typeof sqrtRatioLimitOpt === "undefined") {
                    const isToken1 = nextSpecifiedToken > swapCalculatedTokenBig;
                    const isPriceIncreasing = isToken1 !== isExactOut;

                    sqrtRatioLimit = isPriceIncreasing ? MAX_SQRT_RATIO : MIN_SQRT_RATIO;
                } else {
                    sqrtRatioLimit = sqrtRatioLimitOpt;
                }

                calldata.push(numberToBytes(sqrtRatioLimit, { size: SQRT_RATIO_LIMIT_BYTES }));
            }

            nextSpecifiedToken = swapCalculatedTokenBig;
        }
    }

    if (withIntegrationFee) {
        calldata.push(
            numberToBytes(integrationFee.fee, { size: FEE_SHARE_BYTES }),
            hexToBytes(getAddress(integrationFee.integrator)),
        );
    }

    if (withRecipient) {
        calldata.push(hexToBytes(getAddress(recipient)));
    }

    return bytesToHex(concatBytes(calldata));
}

function abs(big: bigint): bigint {
    return big < 0n ? -big : big;
}

function tokenId(address: string): number | null {
    const idx = TOKENS.findIndex(token => token.address === address);
    return idx === -1 ? null : idx;
}