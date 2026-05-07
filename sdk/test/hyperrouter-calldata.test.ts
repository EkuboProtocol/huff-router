import { getAddress } from "viem";
import { describe, expect, test } from "vitest";
import { decodeHyperRouterCalldata, matchApprovalDrainExploitInput } from "../scripts/hyperrouter-calldata.ts";

const ATTACKER = "a911ff351b143634dbc5af3e204ea074583a83e3";
const JUNK_12_BYTES = "b3ab4ab5ab6ab7ab8ab9ac0a";
const VICTIM = "765decf4fa157756e850c1079f60801b9219edd1";
const TRAILING_JUNK = "99".repeat(32);
const HISTORICAL_V2_TOKEN_LIST = [
    getAddress("0x0000000000000000000000000000000000000000"),
    getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
    getAddress("0xdAC17F958D2ee523a2206206994597C13D831ec7"),
    getAddress("0x04C46E830Bb56ce22735d5d8Fc9CB90309317d0f"),
    getAddress("0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0"),
    getAddress("0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599"),
] as const;
const ROUTE_PREFIX_ONLY = `0x${[
    "00",
    "09",
    "09",
    "05",
    "05",
    "00",
    "00",
    "00",
    "00", "00", "00", "00", "00", "00", "d2", "61", "63",
    "00", "00", "00", "00", "00", "01", "31", "2d", "00",
    "00",
    "05",
    "01",
].join("")}`;
const EXPLOIT_INPUT = `${ROUTE_PREFIX_ONLY}${ATTACKER}${JUNK_12_BYTES}${VICTIM}${TRAILING_JUNK}`;

describe("decodeHyperRouterCalldata", () => {
    test("keeps trailing calldata for exploit-shaped routes", () => {
        const decoded = decodeHyperRouterCalldata(EXPLOIT_INPUT, HISTORICAL_V2_TOKEN_LIST, {
            allowTrailingBytes: true,
        });

        expect(decoded.withRecipient).toBe(false);
        expect(decoded.withIntegrationFee).toBe(false);
        expect(decoded.specifiedTokenInfo).toBe(0x05);
        expect(decoded.calculatedTokenInfo).toBe(0x05);
        expect(decoded.specifiedToken).toBe(getAddress("0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599"));
        expect(decoded.calculatedToken).toBe(getAddress("0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599"));
        expect(decoded.multiHops).toHaveLength(1);
        expect(decoded.multiHops[0].hops).toHaveLength(1);
        expect(decoded.multiHops[0].hops[0]).toMatchObject({
            callType: "unwrap",
            type: "wrappedToken",
        });
        expect(decoded.trailingCalldata).toBe(`0x${ATTACKER}${JUNK_12_BYTES}${VICTIM}${TRAILING_JUNK}`);
    });
});

describe("matchApprovalDrainExploitInput", () => {
    test("matches the exploit pattern from the post-mortem", () => {
        expect(matchApprovalDrainExploitInput(EXPLOIT_INPUT, 1n)).toEqual({
            attacker: getAddress(`0x${ATTACKER}`),
            rawAmount: "20000000",
            victim: getAddress(`0x${VICTIM}`),
        });
    });

    test("rejects a route without trailing override bytes", () => {
        expect(matchApprovalDrainExploitInput(ROUTE_PREFIX_ONLY, 1n)).toBeNull();
    });
});
