// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.33;

import {IHuffRouter} from "./HuffRouter.sol";

contract CreateHuffRouter {
    struct InitializationParams {
        uint256 expirationTimestamp;
        address integrator;
        address[] tokens;
    }

    error Create2Failed();

    event HuffRouterCreated(address indexed creator, IHuffRouter indexed router, bytes32 indexed salt);

    uint256 private constant _EXPIRATION_TIMESTAMP_SLOT = 0;
    uint256 private constant _INTEGRATOR_SLOT = 1;
    uint256 private constant _TOKENS_LENGTH_SLOT = 2;
    uint256 private constant _TOKENS_BASE_SLOT = 3;

    bytes private _initCode;

    constructor(bytes memory initCode) {
        _initCode = initCode;
    }

    function create(InitializationParams calldata params) external returns (IHuffRouter deployed) {
        bytes32 salt = computeSalt(msg.sender, params);
        bytes memory initCode = _initCode;

        _setInitializationParams(params);

        assembly ("memory-safe") {
            deployed := create2(0, add(initCode, 0x20), mload(initCode), salt)
        }

        if (address(deployed) == address(0)) revert Create2Failed();

        emit HuffRouterCreated(msg.sender, deployed, salt);
    }

    function computeSalt(address creator, InitializationParams calldata params) public pure returns (bytes32 salt) {
        salt = keccak256(abi.encodePacked(creator, params.expirationTimestamp, params.integrator));
    }

    function _transientInitializationParams() external view {
        assembly ("memory-safe") {
            let free := mload(0x40)
            mstore(free, tload(_EXPIRATION_TIMESTAMP_SLOT))
            mstore(add(free, 0x20), tload(_INTEGRATOR_SLOT))

            let tokenLength := tload(_TOKENS_LENGTH_SLOT)
            let memOffset := add(free, 0x40)

            for {
                let i := 0
                let transientOffset := _TOKENS_BASE_SLOT
            } lt(i, tokenLength) {
                i := add(i, 1)
                memOffset := add(memOffset, 20)
                transientOffset := add(transientOffset, 1)
            } {
                mstore(memOffset, shl(96, tload(transientOffset)))
            }

            return(free, sub(memOffset, free))
        }
    }

    function _setInitializationParams(InitializationParams calldata params) private {
        _tstore(_EXPIRATION_TIMESTAMP_SLOT, params.expirationTimestamp);
        _tstore(_INTEGRATOR_SLOT, uint256(uint160(params.integrator)));
        _tstore(_TOKENS_LENGTH_SLOT, params.tokens.length);

        for (uint256 i = 0; i < params.tokens.length; i++) {
            _tstore(_TOKENS_BASE_SLOT + i, uint256(uint160(params.tokens[i])));
        }
    }

    function _tstore(uint256 slot, uint256 value) private {
        assembly ("memory-safe") {
            tstore(slot, value)
        }
    }
}
