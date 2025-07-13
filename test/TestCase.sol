// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {NATIVE_TOKEN_ADDRESS} from "ekubo/src/math/constants.sol";
import {TokenInfo, resolve} from "./TokenInfo.sol";

using {resolve} for address[];

struct IntegrationFee {
    uint16 share;
    address integrator;
}

function nonZeroShare(IntegrationFee memory integrationFee) pure returns (bool) {
    return integrationFee.share != 0;
}

using {nonZeroShare} for IntegrationFee global;

struct PoolConfig {
    address extension;
    uint64 fee;
    uint32 tickSpacing;
}

struct Swap {
    PoolConfig config;
    bool isKnownExtension;
    uint8 skipAhead;
    TokenInfo calculatedTokenInfo;
    uint96 sqrtRatioLimit;
}

struct MultiHopSwap {
    uint128 specifiedAmount;
    Swap[] swaps;
}

struct TestCase {
    TokenInfo specifiedTokenInfo;
    TokenInfo calculatedTokenInfo;
    bool isExactOut;
    bool withSqrtRatioLimit;
    MultiHopSwap[] multiHopSwaps;
    bool delegateCall;
    address recipient;
    uint128 calculatedAmountThreshold;
    IntegrationFee integrationFee;
    int128 expectedTokenInDiff;
    int128 expectedTokenOutDiff;
    uint128 expectedIntegratorDiff;
}

function name(TestCase memory testCase, address[] memory tokens) pure returns (string memory) {
    return string.concat(
        "specified",
        testCase.specifiedTokenInfo.isKnown ? "Known" : "Unknown",
        tokens.resolve(testCase.specifiedTokenInfo) == NATIVE_TOKEN_ADDRESS ? "Native" : "ERC20",
        "_calculated",
        testCase.calculatedTokenInfo.isKnown ? "Known" : "Unknown",
        tokens.resolve(testCase.calculatedTokenInfo) == NATIVE_TOKEN_ADDRESS ? "Native" : "ERC20"
    );
}

using {name} for TestCase global;
