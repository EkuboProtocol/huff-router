// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {IExposedStorage} from "../interfaces/IExposedStorage.sol";

/// @dev This library includes some helper functions for calling IExposedStorage#sload and IExposedStorage#tload.
library ExposedStorageLib {
    function sload(IExposedStorage target, bytes32 slot) internal view returns (bytes32 result) {
        assembly ("memory-safe") {
            mstore(0, shl(224, 0x380eb4e0))
            mstore(4, slot)

            if iszero(staticcall(gas(), target, 0, 36, 0, 32)) { revert(0, 0) }

            result := mload(0)
        }
    }
}
