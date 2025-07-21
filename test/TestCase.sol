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

struct BasePoolConfig {
    uint64 fee;
    uint32 tickSpacing;
}

using {toPoolConfig} for BasePoolConfig global;

function toPoolConfig(BasePoolConfig memory basePoolConfig) pure returns (PoolConfig memory poolConfig) {
    poolConfig = PoolConfig({extension: address(0), fee: basePoolConfig.fee, tickSpacing: basePoolConfig.tickSpacing});
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
}

using {name} for TestCase global;

//

// To test: knownExtension, knownSpecified, knownCalculated, one vs two vs three swaps, resp. multiHopSwaps, different extensions, exactOut, native vs ERC20,
// integrationFee, delegatecall, sqrtRatioLimit, withRecipient
function name(TestCase memory testCase, address[] memory tokens) pure returns (string memory) {
    address specifiedToken = tokens.resolve(testCase.specifiedTokenInfo);
    address calculatedToken = tokens.resolve(testCase.calculatedTokenInfo);

    string memory multiHopSwapsCountStr;
    string memory swapsCountStr;

    uint256 multiHopSwapsCount = testCase.multiHopSwaps.length;
    uint256 swapsCount;

    for (uint256 i = 0; i < multiHopSwapsCount; i++) {
        MultiHopSwap memory multiHopSwap = testCase.multiHopSwaps[i];

        if (swapsCount == 0) {
            swapsCount = multiHopSwap.swaps.length;
        } else {
            // require(swapsCount == multiHopSwap.swaps.length);
        }
    }

    return string.concat(
        "specified",
        testCase.specifiedTokenInfo.isKnown ? "Known" : "Unknown",
        specifiedToken == NATIVE_TOKEN_ADDRESS ? "Native" : "ERC20",
        "_",
        "calculated",
        testCase.calculatedTokenInfo.isKnown ? "Known" : "Unknown",
        calculatedToken == NATIVE_TOKEN_ADDRESS ? "Native" : "ERC20",
        "_",
        specifiedToken == calculatedToken ? "arbitrage" : "simple"
    );
}
