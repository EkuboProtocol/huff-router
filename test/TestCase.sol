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
    bool isKnownExtension;
    uint8 skipAhead;
    TokenIdOrAddress calculatedTokenIdOrAddress;
    uint96 sqrtRatioLimit;
}

struct MultiHopSwap {
    uint128 specifiedAmount;
    Swap[] swaps;
}

struct TestCase {
    TokenIdOrAddress specifiedTokenIdOrAddress;
    TokenIdOrAddress calculatedTokenIdOrAddress;
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
