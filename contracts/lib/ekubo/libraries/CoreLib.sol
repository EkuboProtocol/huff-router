// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {ICore} from "../interfaces/ICore.sol";
import {ExposedStorageLib} from "./ExposedStorageLib.sol";
import {EfficientHashLib} from "solady/utils/EfficientHashLib.sol";

// Common storage getters we need for external contracts are defined here instead of in the core contract
library CoreLib {
    using ExposedStorageLib for *;

    function savedBalances(ICore core, address owner, address token, bytes32 salt)
        internal
        view
        returns (uint128 savedBalance)
    {
        bytes32 key = EfficientHashLib.hash(
            bytes32(uint256(uint160(owner))),
            bytes32(uint256(uint160(token))),
            bytes32(uint256(type(uint160).max)),
            salt
        );
        assembly ("memory-safe") {
            mstore(0, key)
            mstore(32, 8)
            key := keccak256(0, 64)
        }

        savedBalance = uint128(uint256(core.sload(key)) >> 128);
    }
}
