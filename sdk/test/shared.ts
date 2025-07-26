import { Hex, zeroAddress } from "viem";
import { ORACLE_ADDRESS } from "../src/extensions";
import { generateCalldata } from "../src";

export const ETH_ADDRESS = zeroAddress;
export const USDC_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
export const USDT_ADDRESS = "0xdAC17F958D2ee523a2206206994597C13D831ec7";

export const ORACLE_CONFIG = { extension: ORACLE_ADDRESS, fee: 0n, tickSpacing: 0 };

export const INTEGRATOR = "0x4a77e6131A6b8067042A0F9dDfaC9eB4cf18e219";

export function minimalCalldata(): Hex {
    return generateCalldata({
        specifiedToken: ETH_ADDRESS,
        multiHopSwaps: [
            {
                specifiedAmount: 0n,
                swaps: [
                    {
                        poolConfig: {
                            extension: ORACLE_ADDRESS,
                            fee: 0n,
                            tickSpacing: 0,
                        },
                        calculatedToken: USDC_ADDRESS,
                    }
                ]
            }
        ]
    });
}
