import { BytesLike, concat, getAddress, getBigInt, MaxUint256, toBeArray, toBeHex, ZeroAddress } from "ethers";
import TOKENS from "../../tokens/ethereum.json";
import { ORACLE_ADDRESS, TWAMM_ADDRESS, MEV_RESIST_ADDRESS } from "./address";

/**
 * The unique identifier of a pool (excluding token0 and token1)
 */
export interface PoolConfig {
    /**
     * The address of the pool's extension
     *
     * @remarks
     * Base pools (which includes both concentrated liquidity and full range pools) have this set to the zero address
     */
    extension: string,
    /**
     * The swap and withdrawal fee
     */
    fee: bigint,
    /**
     * The minimum number of ticks between two initialized ticks
     */
    tickSpacing: number,
}

/**
 * Describes one hop of a {@link MultiHopSwap}
 */
export interface Swap {
    /**
     * The pool config of the pool that this swap describes
     */
    poolConfig: PoolConfig,
    /**
     * The address of the token in which the calculated amount of this swap is denominated
     */
    calculatedToken: string,
    /**
     * The `skipAhead` parameter of a swap
     *
     * @remarks
     * This value isn't useful for every pool type (e.g. for full range pools).
     *
     * Must fit into an `uint8`.
     *
     * @defaultValue
     * `0`
     */
    skipAhead?: number,
    /**
     * The price limit for this swap in compact 96 bit fixed point representation
     *
     * @remarks
     * Has to be a valid according to the Ekubo Core's validation rules.
     *
     * Note that if you specify the price limit for just one swap, the generated calldata will need
     * to contain price limits for every other swap, potentially increasing the gas costs by a lot.
     *
     * @defaultValue
     * Depending on the direction of the swap, the minimum or maximum price
     */
    sqrtRatioLimit?: bigint,
}

/**
 * A sequence of swaps, passing along the calculated amount of the previous swap to the next one
 */
export interface MultiHopSwap {
    /**
     * The specified amount of the first swap
     *
     * @remarks
     * A negative amount indicates an exact-out, a non-negative amount an exact-in swap.
     *
     * Must fit into an `int128`.
     */
    specifiedAmount: bigint,
    /**
     * A sequence of swaps
     *
     * @remarks
     * The length of the array must be non-zero and at most 256.
     */
    swaps: Swap[],
}

/**
 * Allows rewarding integrators for the provision of their services
 * by sharing parts of the swap amount with them
 */
export interface IntegrationFee {
    /**
     * A 0.16 fixed point number describing the share of the swap amount
     * that will be saved for the integrator
     *
     * @remarks
     * For exact-in swaps, the share is taken from the calculated amount;
     * for exact-out swaps, from the specified amount
     */
    fee: number,
    /**
     * The owner of the saved balance in which Ekubo Core will save the integration fee
     */
    integrator: string,
}

/**
 * The parameters required for constructing a call to the *HyperRouter*
 */
export interface Parameters {
    /**
     * The address of the token in which the {@link MultiHopSwap.specifiedAmount | specified amounts} of the {@link multiHopSwaps} are denominated
     */
    specifiedToken: string,
    /**
     * The address of the token in which the calculated amounts of the final swaps of each {@link MultiHopSwap} are denominated
     */
    calculatedToken: string, // TODO Remove
    /**
     * A sequence of multi-hop swaps
     *
     * @remarks
     * The length of the array has to be non-zero and at most 256.
     *
     * The sign of the {@link MultiHopSwap.specifiedAmount | specified amounts} and the
     * {@link Swap.calculatedToken | calculated tokens} of the last swaps have to be equivalent for all elements.
     */
    multiHopSwaps: MultiHopSwap[],
    /**
     * The recipient of the tokens received from Ekubo Core
     *
     * @defaultValue
     * If the *HyperRouter* is called via a `call`, the `caller`; if called via a `delegatecall`, the delegating contract.
     */
    recipient?: string,
    /**
     * A slippage check for the total calculated amount after the execution of all swaps
     *
     * @remarks
     * Needs to have the same sign as the {@link MultiHopSwap.specifiedAmount | specified amounts}.
     *
     * If the swap is exact-in, specifies the minimum amount received; if exact-in, the maximum amount spent.
     *
     * The magnitude of this value must fit into an `uint256`.
     *
     * @defaultValue
     * Effectively disables the slippage check
     */
    calculatedAmountThreshold?: bigint,
    /**
     * The integration fee that is applied to the total swap amount
     *
     * @defaultValue
     * No integrator receives a share from the swap amount
     */
    integrationFee?: IntegrationFee,
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

/**
 * Generates calldata which can both be used in a `call` or a `delegatecall` to the *HyperRouter*.
 *
 * If called via a `call`, depending on the type of the token that needs to be transferred to Ekubo Core:
 * - ERC-20: The *HyperRouter* needs an approval from the `caller`
 * - Native token: Has to be transferred directly to the *HyperRouter*.
 *      If the swap is exact-out, the remaining balance of the *HyperRouter* after settlement will be refunded to
 *      the `caller`.
 *
 * If called via a `delegatecall`, all transfers happen directly from the delegating contract and no approvals,
 * transfers, or refunds are necessary.
 *
 * @param params - The parameters determining the generated calldata
 * @returns A hex-encoded calldata string
 */
export function generateCalldata(params: Parameters): string {
    const { multiHopSwaps, recipient, calculatedAmountThreshold, integrationFee } = params;
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
    const withIntegrationFee = typeof integrationFee !== "undefined" && integrationFee.fee !== 0;

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
            // https://github.com/ethers-io/ethers.js/issues/5025
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
            toBeHex(integrationFee.fee, FEE_SHARE_BYTES),
            getAddress(integrationFee.integrator),
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
