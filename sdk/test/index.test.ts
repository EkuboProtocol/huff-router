import { assert, expect, test } from "vitest";
import TOKENS from "../../tokens/ethereum.json";
import { isAddress, size } from "viem";
import { minimalCalldata } from "./minimal";

test("minimal calldata size", () => {
    expect(size(minimalCalldata())).toBe(10);
});

test("token addresses should be checksummed", () => {
    for (const { symbol, address } of TOKENS) {
        assert(isAddress(address), `${symbol} should have a checksummed address`);
    }
})
