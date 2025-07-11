// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

struct TokenIdOrAddress {
    address value;
    bool isId;
}

function tokenId(TokenIdOrAddress memory idOrAddress) pure returns (bytes1 id) {
    if (idOrAddress.isId) {
        id = bytes1(uint8(uint160(idOrAddress.value)));
    } else {
        id = 0xff;
    }
}

using {tokenId} for TokenIdOrAddress global;

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
    bool isUnknown;
    uint8 skipAhead;
    TokenIdOrAddress calculatedTokenIdOrAddress;
    uint96 sqrtRatioLimit;
}

struct MultiHopSwap {
    uint128 specifiedAmount;
    Swap[] swaps;
}

struct TestCase {
    address recipient;
    uint128 calculatedAmountThreshold;
    TokenIdOrAddress specifiedTokenIdOrAddress;
    TokenIdOrAddress calculatedTokenIdOrAddress;
    IntegrationFee integrationFee;
    bool isExactOut;
    bool withSqrtRatioLimit;
    MultiHopSwap[] multiHopSwaps;
}
