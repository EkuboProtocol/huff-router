import { BytesLike, concat, getAddress, getBigInt, MaxUint256, toBeArray, toBeHex, ZeroAddress } from "ethers";
import TOKENS from "../../tokens/ethereum.json";
import { ORACLE_ADDRESS, TWAMM_ADDRESS, MEV_RESIST_ADDRESS } from "./address";

export interface PoolConfig {
    extension: string,
    fee: bigint,
    tickSpacing: number,
}

export interface Swap {
    poolConfig: PoolConfig,
    calculatedToken: string,
    skipAhead?: number,
    sqrtRatioLimit?: bigint,
}

export interface MultiHopSwap {
    specifiedAmount: bigint,
    swaps: Swap[],
}

export interface IntegrationFeeInfo {
    share: number,
    integrator: string,
}

export interface Parameters {
    specifiedToken: string,
    calculatedToken: string,
    multiHopSwaps: MultiHopSwap[],
    recipient?: string,
    calculatedAmountThreshold?: bigint,
    integrationFeeInfo?: IntegrationFeeInfo,
}

const INT128_MIN = -0x80000000000000000000000000000000n;
const INT128_MAX = 0x7fffffffffffffffffffffffffffffffn;

const TWO_POW_62 = 2n ** 62n;
const TWO_POW_256 = MaxUint256 + 1n;

const FEE_BYTES = 8;
const TICK_SPACING_BYTES = 4;
const SQRT_RATIO_LIMIT_BYTES = 12;
const FEE_SHARE_BYTES = 2;

const MIN_SQRT_RATIO = 4611797791050542631n;
const MAX_SQRT_RATIO = 79227682466138141934206691491n;
const NOT_BIT_MASK = 0x3fffffffffffffffffffffffn;

const UNKNOWN_TOKEN = 0xff;

export function generateCalldata(params: Parameters): string {
    const { multiHopSwaps, recipient, calculatedAmountThreshold, integrationFeeInfo } = params;
    const [specifiedToken, calculatedToken] = [getAddress(params.specifiedToken), getAddress(params.calculatedToken)];

    if (multiHopSwaps.length < 1 || multiHopSwaps.length > 256) {
        throw new Error("need between one and 256 multiHopSwaps");
    }

    let maxSpecified = 0n;
    let withSqrtRatioLimit = false;
    let isExactOut: boolean | null = null;

    for (const { specifiedAmount, swaps } of multiHopSwaps) {
        if (swaps.length < 1 || swaps.length > 256) {
            throw new Error("each multiHopSwap needs to consist of at least one and at most 256 swaps");
        }

        const specifiedAmountUnsigned = specifiedAmount > 0n ? specifiedAmount : -specifiedAmount;

        if (maxSpecified < specifiedAmountUnsigned) {
            maxSpecified = specifiedAmountUnsigned;
        }

        if (specifiedAmount !== 0n) {
            if (specifiedAmount < INT128_MIN || specifiedAmount > INT128_MAX) {
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

            if (i == swaps.length - 1 && getAddress(swapCalculatedToken) !== calculatedToken) {
                throw new Error("last swaps of each multiHopSwap must end at the calculated token");
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

        if (calculatedAmountThresholdAbs > MaxUint256) {
            throw new Error("absolute value of calculatedAmountThreshold can't exceed maximum uint256 value");
        }

        if (isExactOutThreshold) {
            calculatedAmountThresholdUnsigned = (calculatedAmountThresholdAbs + 1n) % TWO_POW_256;
        } else {
            calculatedAmountThresholdUnsigned = calculatedAmountThresholdAbs;
        }
    }

    isExactOut ??= (calculatedAmountThreshold ?? 0n) < 0n;

    const withRecipient = typeof recipient !== "undefined";
    const specifiedAmountBytes = toBeArray(maxSpecified).length;
    const calculatedAmountThresholdBin = toBeArray(calculatedAmountThresholdUnsigned);
    const [specifiedTokenId, calculatedTokenId] = [tokenId(specifiedToken), tokenId(calculatedToken)];
    const withIntegrationFee = typeof integrationFeeInfo !== "undefined";

    let calldata: BytesLike[] = [
        new Uint8Array([
            Number(withRecipient),
            specifiedAmountBytes,
            calculatedAmountThresholdBin.length,
            specifiedTokenId ?? UNKNOWN_TOKEN,
            calculatedTokenId ?? UNKNOWN_TOKEN,
            multiHopSwaps.length - 1,
            Number(withIntegrationFee),
            (Number(withSqrtRatioLimit) << 1) + Number(isExactOut),
        ]),
        calculatedAmountThresholdBin,
    ];

    if (specifiedTokenId === null) {
        calldata.push(specifiedToken);
    }

    if (calculatedTokenId === null) {
        calldata.push(calculatedToken);
    }

    for (const { specifiedAmount, swaps } of multiHopSwaps) {
        calldata.push(
            specifiedAmountBytes > 0 ? toBeHex(specifiedAmount, specifiedAmountBytes) : "0x",
            new Uint8Array([swaps.length - 1]),
        );

        let nextSpecifiedToken = getBigInt(specifiedToken);

        for (let i = 0; i < swaps.length; i++) {
            const swap = swaps[i];
            const { poolConfig, sqrtRatioLimit: sqrtRatioLimitOpt } = swap;
            const { fee, tickSpacing } = poolConfig;
            const swapCalculatedToken = getAddress(swap.calculatedToken);

            const extension = getAddress(poolConfig.extension);
            const skipAhead = swap.skipAhead ?? 0;

            switch (extension) {
                case ZeroAddress:
                    calldata.push(
                        new Uint8Array([
                            0,
                            skipAhead,
                        ]),
                        toBeHex(fee, FEE_BYTES),
                        toBeHex(tickSpacing, TICK_SPACING_BYTES),
                    );
                    break;
                case ORACLE_ADDRESS:
                    calldata.push(
                        new Uint8Array([
                            1,
                        ]),
                    );
                    break;
                case TWAMM_ADDRESS:
                    calldata.push(
                        new Uint8Array([
                            2,
                        ]),
                        toBeHex(fee, FEE_BYTES),
                    );
                    break;
                case MEV_RESIST_ADDRESS:
                    calldata.push(
                        new Uint8Array([
                            3,
                            skipAhead,
                        ]),
                        toBeHex(fee, FEE_BYTES),
                        toBeHex(tickSpacing, TICK_SPACING_BYTES),
                    );
                    break;
                default:
                    calldata.push(
                        new Uint8Array([
                            4,
                            skipAhead,
                        ]),
                        extension,
                        toBeHex(fee, FEE_BYTES),
                        toBeHex(tickSpacing, TICK_SPACING_BYTES),
                    );
            }

            if (i !== swaps.length - 1) {
                const swapCalculatedTokenId = tokenId(swapCalculatedToken);

                calldata.push(new Uint8Array([swapCalculatedTokenId ?? UNKNOWN_TOKEN]));

                if (swapCalculatedTokenId === null) {
                    calldata.push(swapCalculatedToken);
                }
            }

            const swapCalculatedTokenBig = getBigInt(swapCalculatedToken);

            if (withSqrtRatioLimit) {
                let sqrtRatioLimit;

                if (typeof sqrtRatioLimitOpt === "undefined") {
                    const isToken1 = nextSpecifiedToken > swapCalculatedTokenBig;
                    const isPriceIncreasing = isToken1 !== isExactOut;

                    sqrtRatioLimit = isPriceIncreasing ? MAX_SQRT_RATIO : MIN_SQRT_RATIO;
                } else {
                    sqrtRatioLimit = sqrtRatioLimitOpt;
                }

                calldata.push(toBeHex(sqrtRatioLimit, SQRT_RATIO_LIMIT_BYTES));
            }

            nextSpecifiedToken = swapCalculatedTokenBig;
        }
    }

    if (withIntegrationFee) {
        calldata.push(
            toBeHex(integrationFeeInfo.share, FEE_SHARE_BYTES),
            getAddress(integrationFeeInfo.integrator),
        );
    }

    if (withRecipient) {
        calldata.push(getAddress(recipient));
    }

    return concat(calldata);
}

function tokenId(address: string): number | null {
    const idx = TOKENS.findIndex(token => token.address === address);
    return idx === -1 ? null : idx;
}
