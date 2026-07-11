import { Address, Hex } from "viem";
import { generateCalldataImpl } from "./impl";

export const DEPLOYMENTS: Map<bigint, Address> = new Map([
  [1n, "0x4F168f17923435c999f5C8565ACAb52C2218EdF2"],
  [42161n, "0xC93C4Ad185CA48d66FEfe80f906a67ef859fc47d"],
  [11155111n, "0xf9bf8E1f79D8Ee9983abf3bE674B815d5d499a2E"],
  [46630n, "0xC93C4Ad185CA48d66FEfe80f906a67ef859fc47d"],
  [4326n, "0xC93C4Ad185CA48d66FEfe80f906a67ef859fc47d"],
]);

/**
 * The unique identifier of a pool
 */
export interface PoolKey {
  /**
   * The numerically smaller token of this pool's token pair
   */
  token0: Hex;
  /**
   * The numerically larger token of this pool's token pair
   */
  token1: Hex;
  /**
   * The concatenated extension address (20 bytes) | fee (8 bytes) | pool type config (4 bytes)
   */
  config: Hex;
}

/**
 * Describes a swap on a liquidity pool
 */
export interface Swap {
  type: "swap";

  /**
   * The pool key of the pool that should be swapped on
   */
  poolKey: PoolKey;
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
  skipAhead?: number;
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
  sqrtRatioLimit?: bigint;
}

/**
 * Describes the wrapping or unwrapping of a timelocked token
 *
 * @remarks
 * Only works with contracts instantiated via Ekubo's [*TokenWrapperFactory*](https://docs.ekubo.org/integration-guides/reference/contract-addresses#ethereum)
 */
export interface WrappedToken {
  type: "wrappedToken";

  /**
   * The underlying ERC-20 token
   */
  underlying: Hex;
  /**
   * The *TokenWrapper* contract
   */
  wrapped: Hex;
}

/**
 * Describes one hop of a {@link MultiHop}
 */
export type Hop = Swap | WrappedToken;

/**
 * A sequence of hops, passing along the calculated amount of the previous hop to the next one
 */
export interface MultiHop {
  /**
   * The specified amount of the first hop
   *
   * @remarks
   * A negative amount indicates an exact-out, a non-negative amount an exact-in multi-hop.
   *
   * Must fit into an `int128`.
   */
  specifiedAmount: bigint;
  /**
   * A sequence of hops
   *
   * @remarks
   * The length of the array must be non-zero and at most 256.
   */
  hops: Hop[];
}

/**
 * The parameters required for constructing a call to the *HuffRouter*
 */
export interface Parameters {
  /**
   * The chain ID of the chain that the *HuffRouter* instance for which the calldata is generated is deployed on
   */
  chainId: bigint;
  /**
   * The address of the token in which the {@link MultiHop.specifiedAmount | specified amounts} of the {@link multiHops} are denominated
   */
  specifiedToken: Hex;
  /**
   * A sequence of multi-hops
   *
   * @remarks
   * The length of the array has to be non-zero and at most 256.
   *
   * The sign of the {@link MultiHop.specifiedAmount | specified amounts} and the
   * {@link Hop.calculatedToken | calculated tokens} of the last hops have to be equivalent for all elements.
   */
  multiHops: MultiHop[];
  /**
   * The recipient of the tokens received from Ekubo Core
   *
   * @defaultValue
   * The `caller`
   */
  recipient?: Hex;
  /**
   * A slippage check for the total calculated amount after the execution of all hops
   *
   * @remarks
   * Needs to have the same sign as the {@link MultiHop.specifiedAmount | specified amounts}.
   *
   * If the route is exact-in, specifies the minimum amount received; if exact-in, the maximum amount spent.
   *
   * The magnitude of this value must fit into an `uint256`.
   *
   * @defaultValue
   * Effectively disables the slippage check
   */
  calculatedAmountThreshold?: bigint;
}

/**
 * Generates calldata for the *HuffRouter*.
 *
 * Depending on the type of the token that needs to be transferred to Ekubo Core:
 * - ERC-20: The *HuffRouter* needs an approval from the `caller`
 * - Native token: Has to be transferred directly to the *HuffRouter*.
 *      If the route is exact-out, the remaining balance of the *HuffRouter* after settlement will be refunded to
 *      the `caller`.
 *
 * @param params - The parameters determining the generated calldata
 * @returns A hex-encoded calldata string
 */
export function generateCalldata(params: Parameters): Hex {
  return generateCalldataImpl(params);
}
