import { Hex } from "viem";
import { generateCalldata } from "../src";
import { ORACLE_ADDRESS } from "../src/extensions";
import { ETH_ADDRESS, USDC_ADDRESS } from "./tokens";

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