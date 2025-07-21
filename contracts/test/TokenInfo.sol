// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

struct TokenInfo {
    address value;
    bool isKnown;
}

function id(TokenInfo memory info) pure returns (bytes1) {
    if (info.isKnown) {
        return bytes1(uint8(uint160(info.value)));
    } else {
        return 0xff;
    }
}

using {id} for TokenInfo global;

function resolve(address[] memory tokens, TokenInfo memory info) pure returns (address token) {
    token = info.isKnown ? tokens[uint256(uint160(info.value))] : info.value;
}
