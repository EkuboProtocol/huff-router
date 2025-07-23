import { assert, expect, test } from "vitest";
import { generateCalldata } from ".";
import { getAddress, isAddress, WeiPerEther, ZeroAddress } from "ethers";
import { ORACLE_ADDRESS, TWAMM_ADDRESS } from "./address";
import TOKENS from "../../tokens/ethereum.json";

const ETH_ADDRESS = ZeroAddress;
const USDC_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDT_ADDRESS = "0xdAC17F958D2ee523a2206206994597C13D831ec7";

const RECIPIENT = "0x00000C771F6176268D5A9846E0956C3eF58597A1";
const INTEGRATOR = "0xf94e5Cdf41247E268d4847C30A0DC2893B33e85d";

const SQRT_RATIO_ONE = 0b110000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000n;

test("minimal calldata", () => {
    expect(generateCalldata({
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
    })).toBe("0x00000000010000000001");
});

test("complex scenario", () => {
    expect(generateCalldata({
        specifiedToken: ETH_ADDRESS,
        recipient: RECIPIENT,
        calculatedAmountThreshold: 0x0123n,
        integrationFee: {
            fee: 0xabcd,
            integrator: INTEGRATOR,
        },
        multiHopSwaps: [
            {
                specifiedAmount: WeiPerEther,
                swaps: [
                    {
                        poolConfig: {
                            extension: TWAMM_ADDRESS,
                            fee: 9223372036854775n,
                            tickSpacing: 0,
                        },
                        calculatedToken: USDC_ADDRESS,
                    },
                    {
                        poolConfig: {
                            extension: ZeroAddress,
                            fee: 92233720368547n,
                            tickSpacing: 50,
                        },
                        calculatedToken: USDT_ADDRESS,
                        skipAhead: 10,
                        sqrtRatioLimit: SQRT_RATIO_ONE,
                    }
                ],
            },
            {
                specifiedAmount: WeiPerEther / 2n,
                swaps: [
                    {
                        poolConfig: {
                            extension: ZeroAddress,
                            fee: 3689348814741910n,
                            tickSpacing: 4990,
                        },
                        calculatedToken: USDT_ADDRESS,
                    }
                ],
            },
        ]
    })).toBe("0x010802000201010201230de0b6b3a764000001020020c49ba5e353f70100000000400065a8177fae27000a000053e2d6238da300000032c0000000400000000000000006f05b59d3b20000000000000d1b71758e21960000137e00000000400065a8177fae27abcdf94e5cdf41247e268d4847c30a0dc2893b33e85d00000c771f6176268d5a9846e0956c3ef58597a1");
});

test("token addresses should be checksummed", () => {
    for (const { address } of TOKENS) {
        assert(isAddress(address) && getAddress(address) === address, `${address} should be a checksummed address`);
    }
})
