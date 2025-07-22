// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {MEV_RESIST_ADDRESS, ORACLE_ADDRESS, TWAMM_ADDRESS} from "../src/HyperRouter.sol";
import {TokenInfo, resolve} from "./TokenInfo.sol";
import {NATIVE_TOKEN_ADDRESS} from "ekubo/src/math/constants.sol";

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

using {tableTestName} for TestCase global;

function tableTestName(TestCase memory testCase, address[] memory tokens) pure returns (string memory) {
    address specifiedToken = tokens.resolve(testCase.specifiedTokenInfo);
    address calculatedToken = tokens.resolve(testCase.calculatedTokenInfo);

    Swap memory firstSwap = testCase.multiHopSwaps[0].swaps[0];

    address extension = firstSwap.config.extension;
    string memory extensionStr;

    if (!firstSwap.isKnownExtension) {
        extensionStr = "unknown";
    } else if (extension == address(0)) {
        extensionStr = "base";
    } else if (extension == ORACLE_ADDRESS) {
        extensionStr = "oracle";
    } else if (extension == TWAMM_ADDRESS) {
        extensionStr = "twamm";
    } else if (extension == MEV_RESIST_ADDRESS) {
        extensionStr = "mevResist";
    } else {
        revert("unknown extension");
    }

    return string.concat(
        "specified",
        testCase.specifiedTokenInfo.isKnown ? "Known" : "Unknown",
        specifiedToken == NATIVE_TOKEN_ADDRESS ? "Native" : "ERC20",
        "_calculated",
        testCase.calculatedTokenInfo.isKnown ? "Known" : "Unknown",
        calculatedToken == NATIVE_TOKEN_ADDRESS ? "Native" : "ERC20",
        "_",
        testCase.recipient == address(0) ? "without" : "with",
        "Recipient_",
        testCase.delegateCall ? "delegatecall" : "call",
        "_",
        testCase.withSqrtRatioLimit ? "with" : "without",
        "SqrtRatioLimit_",
        testCase.isExactOut ? "exactOut" : "exactIn",
        "_",
        extensionStr,
        "Extension_",
        specifiedToken == calculatedToken ? "arbitrage" : "simple"
    );
}
