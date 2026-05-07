import { bytesToHex, getAddress, hexToBytes } from "viem";
import type { Hex } from "viem";
import { MEV_CAPTURE_ADDRESS, ORACLE_ADDRESS, TWAMM_ADDRESS } from "../src/extensions.ts";
import { Tokens } from "../src/tokens.ts";

const UNKNOWN_TOKEN_ID = 0xff;
const SQRT_RATIO_BYTES = 12;
const FEE_BYTES = 8;
const TICK_SPACING_BYTES = 4;
const CONFIG_BYTES = 32;
export const ADDRESS_BYTES = 20;
const INTEGRATION_FEE_BYTES = 2;

export interface DecodedPoolKey {
    config: Hex;
    extension: string;
    fee: string | null;
    tickSpacing: string | null;
    token0: Hex;
    token1: Hex;
}

export interface DecodedSwapHop {
    poolKey: DecodedPoolKey;
    skipAhead?: number;
    sqrtRatioLimit?: string;
    type: "swap";
}

export interface DecodedWrappedTokenHop {
    callType: "unwrap" | "wrap";
    type: "wrappedToken";
    underlying: Hex;
    wrapped: Hex;
}

export interface DecodedMultiHop {
    hops: Array<DecodedSwapHop | DecodedWrappedTokenHop>;
    specifiedAmount: bigint;
}

export interface DecodedIntegrationFee {
    fee: number;
    integrator: Hex;
}

export interface DecodedHyperRouterCalldata {
    bytesConsumed: number;
    calculatedAmountThreshold?: string;
    calculatedToken: Hex;
    calculatedTokenInfo: number;
    integrationFee?: DecodedIntegrationFee;
    isExactOut: boolean;
    multiHops: DecodedMultiHop[];
    recipient?: Hex;
    specifiedAmountBytes: number;
    specifiedToken: Hex;
    specifiedTokenInfo: number;
    totalBytes: number;
    trailingCalldata?: Hex;
    withIntegrationFee: boolean;
    withRecipient: boolean;
    withSqrtRatioLimit: boolean;
}

export interface DecodeHyperRouterCalldataOptions {
    allowTrailingBytes?: boolean;
}

export interface ApprovalDrainExploitInputMatch {
    attacker: Hex;
    rawAmount: string;
    victim: Hex;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
    let value = 0n;
    for (const byte of bytes) {
        value = (value << 8n) | BigInt(byte);
    }
    return value;
}

function buildConfig(extension: string, fee: bigint, tickSpacing: bigint): Hex {
    const ext = extension.slice(2).padStart(40, "0");
    const feeHex = fee.toString(16).padStart(16, "0");
    const tickSpacingHex = tickSpacing.toString(16).padStart(8, "0");
    return `0x${ext}${feeHex}${tickSpacingHex}`;
}

function extensionLabel(address: string): string {
    const normalized = getAddress(address);
    if (normalized === getAddress(ORACLE_ADDRESS)) return "oracle";
    if (normalized === getAddress(TWAMM_ADDRESS)) return "twamm";
    if (normalized === getAddress(MEV_CAPTURE_ADDRESS)) return "mev-capture";
    if (normalized === "0x0000000000000000000000000000000000000000") return "base";
    return `unknown (${normalized})`;
}

export function decodeHyperRouterCalldata(
    hex: Hex,
    chainIdOrTokenList: bigint | readonly `0x${string}`[] | null,
    { allowTrailingBytes = false }: DecodeHyperRouterCalldataOptions = {},
): DecodedHyperRouterCalldata {
    const data = hexToBytes(hex);
    let offset = 0;

    function read(length: number): Uint8Array {
        if (offset + length > data.length) {
            throw new Error(
                `Unexpected end of calldata at byte ${offset}: need ${length} byte(s), ${data.length - offset} remain`,
            );
        }

        const slice = data.slice(offset, offset + length);
        offset += length;
        return slice;
    }

    const readByte = (): number => read(1)[0];
    const readUint = (length: number): bigint => (length === 0 ? 0n : bytesToBigInt(read(length)));
    const readAddress = (): Hex => getAddress(bytesToHex(read(ADDRESS_BYTES)));

    const tokens = typeof chainIdOrTokenList === "bigint" ? Tokens.load(chainIdOrTokenList)?.list ?? null : chainIdOrTokenList;

    function resolveToken(id: number): Hex {
        if (id === UNKNOWN_TOKEN_ID) {
            return readAddress();
        }

        if (tokens === null) {
            throw new Error(
                `Token ID ${id} encountered but no token list available; pass chainId or tokenList`,
            );
        }

        const address = tokens[id];
        if (!address) {
            throw new Error(
                `Token ID ${id} is out of range for ${chainIdOrTokenList === null ? "the provided token list" : `chain ${chainIdOrTokenList}`} (list has ${tokens.length} tokens)`,
            );
        }

        return getAddress(address);
    }

    const withRecipient = readByte() !== 0;
    const specifiedAmountBytes = readByte();
    const calculatedAmountThresholdBytes = readByte();
    const specifiedTokenInfo = readByte();
    const calculatedTokenInfo = readByte();
    const additionalMultiHops = readByte();
    const withIntegrationFee = readByte() !== 0;
    const flags = readByte();
    const withSqrtRatioLimit = (flags >> 1) !== 0;
    const isExactOut = (flags & 1) !== 0;

    let calculatedAmountThreshold: string | undefined;
    if (calculatedAmountThresholdBytes > 0) {
        const unsigned = readUint(calculatedAmountThresholdBytes);
        const signed = isExactOut ? 1n - unsigned : unsigned;
        calculatedAmountThreshold = signed.toString();
    }

    const specifiedToken = resolveToken(specifiedTokenInfo);
    const calculatedToken = resolveToken(calculatedTokenInfo);
    const multiHops: DecodedMultiHop[] = [];

    for (let multiHopIndex = 0; multiHopIndex < additionalMultiHops + 1; multiHopIndex++) {
        const specifiedAmountAbsolute = readUint(specifiedAmountBytes);
        const specifiedAmount = (isExactOut ? -specifiedAmountAbsolute : specifiedAmountAbsolute);
        const hopsCount = readByte() + 1;
        const hops: Array<DecodedSwapHop | DecodedWrappedTokenHop> = [];
        let currentToken = specifiedToken;

        for (let hopIndex = 0; hopIndex < hopsCount; hopIndex++) {
            const isLastHop = hopIndex === hopsCount - 1;
            const hopType = readByte();

            if (hopType === 5) {
                const unwrap = readByte() !== 0;
                const nextToken = isLastHop ? calculatedToken : resolveToken(readByte());
                const isUnwrapping = unwrap !== isExactOut;
                const [underlying, wrapped] = isUnwrapping
                    ? [nextToken, currentToken]
                    : [currentToken, nextToken];

                hops.push({
                    callType: unwrap ? "unwrap" : "wrap",
                    type: "wrappedToken",
                    underlying,
                    wrapped,
                });
                currentToken = nextToken;
                continue;
            }

            let skipAhead = 0;
            let fee: bigint | null = null;
            let tickSpacing: bigint | null = null;
            let extension: string;
            let config: Hex;

            if (hopType === 0) {
                skipAhead = readByte();
                fee = readUint(FEE_BYTES);
                tickSpacing = readUint(TICK_SPACING_BYTES);
                extension = "0x0000000000000000000000000000000000000000";
                config = buildConfig(extension, fee, tickSpacing);
            } else if (hopType === 1) {
                extension = ORACLE_ADDRESS;
                config = buildConfig(ORACLE_ADDRESS, 0n, 0n);
            } else if (hopType === 2) {
                fee = readUint(FEE_BYTES);
                extension = TWAMM_ADDRESS;
                config = buildConfig(TWAMM_ADDRESS, fee, 0n);
            } else if (hopType === 3) {
                skipAhead = readByte();
                fee = readUint(FEE_BYTES);
                tickSpacing = readUint(TICK_SPACING_BYTES);
                extension = MEV_CAPTURE_ADDRESS;
                config = buildConfig(MEV_CAPTURE_ADDRESS, fee, tickSpacing);
            } else if (hopType === 4) {
                skipAhead = readByte();
                const configBytes = read(CONFIG_BYTES);
                config = bytesToHex(configBytes);
                extension = getAddress(bytesToHex(configBytes.slice(0, ADDRESS_BYTES)));
                fee = bytesToBigInt(configBytes.slice(ADDRESS_BYTES, ADDRESS_BYTES + FEE_BYTES));
                tickSpacing = bytesToBigInt(configBytes.slice(ADDRESS_BYTES + FEE_BYTES));
            } else {
                throw new Error(`Unknown hop type: ${hopType}`);
            }

            const nextToken = isLastHop ? calculatedToken : resolveToken(readByte());
            const currentTokenBig = BigInt(currentToken);
            const nextTokenBig = BigInt(nextToken);
            const [token0, token1] = currentTokenBig < nextTokenBig
                ? [currentToken, nextToken]
                : [nextToken, currentToken];

            let sqrtRatioLimit: string | undefined;
            if (withSqrtRatioLimit) {
                sqrtRatioLimit = readUint(SQRT_RATIO_BYTES).toString();
            }

            const hop: DecodedSwapHop = {
                poolKey: {
                    config,
                    extension: extensionLabel(extension),
                    fee: fee !== null ? fee.toString() : null,
                    tickSpacing: tickSpacing !== null ? tickSpacing.toString() : null,
                    token0,
                    token1,
                },
                type: "swap",
            };

            if (skipAhead !== 0) {
                hop.skipAhead = skipAhead;
            }

            if (typeof sqrtRatioLimit !== "undefined") {
                hop.sqrtRatioLimit = sqrtRatioLimit;
            }

            hops.push(hop);
            currentToken = nextToken;
        }

        multiHops.push({ hops, specifiedAmount });
    }

    let integrationFee: DecodedIntegrationFee | undefined;
    if (withIntegrationFee) {
        integrationFee = {
            fee: Number(readUint(INTEGRATION_FEE_BYTES)),
            integrator: readAddress(),
        };
    }

    const recipient = withRecipient ? readAddress() : undefined;
    const trailingCalldata = offset < data.length ? bytesToHex(data.slice(offset)) : undefined;

    if (!allowTrailingBytes && trailingCalldata) {
        throw new Error(
            `${data.length - offset} trailing byte(s) not consumed (offset ${offset}/${data.length})`,
        );
    }

    return {
        bytesConsumed: offset,
        ...(typeof calculatedAmountThreshold !== "undefined" ? { calculatedAmountThreshold } : {}),
        calculatedToken,
        calculatedTokenInfo,
        ...(integrationFee ? { integrationFee } : {}),
        isExactOut,
        multiHops,
        ...(recipient ? { recipient } : {}),
        specifiedAmountBytes,
        specifiedToken,
        specifiedTokenInfo,
        totalBytes: data.length,
        ...(trailingCalldata ? { trailingCalldata } : {}),
        withIntegrationFee,
        withRecipient,
        withSqrtRatioLimit,
    };
}

export function matchApprovalDrainExploitInput(
    hex: Hex,
    chainId: bigint,
    options: Omit<DecodeHyperRouterCalldataOptions, "allowTrailingBytes"> = {},
): ApprovalDrainExploitInputMatch | null {
    let decoded: DecodedHyperRouterCalldata;
    try {
        decoded = decodeHyperRouterCalldata(hex, chainId, { ...options, allowTrailingBytes: true });
    } catch {
        return null;
    }

    if (
        decoded.withRecipient
        || decoded.withIntegrationFee
        || decoded.isExactOut
        || decoded.specifiedTokenInfo !== decoded.calculatedTokenInfo
        || decoded.specifiedToken !== decoded.calculatedToken
        || decoded.multiHops.length !== 1
        || !decoded.trailingCalldata
    ) {
        return null;
    }

    const [multiHop] = decoded.multiHops;
    if (multiHop.hops.length !== 1 || multiHop.specifiedAmount <= 0n) {
        return null;
    }

    const [hop] = multiHop.hops;
    if (
        hop.type !== "wrappedToken"
        || hop.callType !== "unwrap"
        || hop.underlying !== hop.wrapped
        || hop.wrapped !== decoded.specifiedToken
    ) {
        return null;
    }

    const trailingBytes = hexToBytes(decoded.trailingCalldata);
    if (trailingBytes.length < 52) {
        return null;
    }

    return {
        attacker: getAddress(bytesToHex(trailingBytes.slice(0, ADDRESS_BYTES))),
        rawAmount: multiHop.specifiedAmount.toString(),
        victim: getAddress(bytesToHex(trailingBytes.slice(32, 52))),
    };
}
