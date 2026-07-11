// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.33;

import {BaseForwardee} from "ekubo/base/BaseForwardee.sol";
import {BaseLocker} from "ekubo/base/BaseLocker.sol";
import {UsesCore} from "ekubo/base/UsesCore.sol";
import {ICore} from "ekubo/interfaces/ICore.sol";
import {IFlashAccountant} from "ekubo/interfaces/IFlashAccountant.sol";
import {CoreLib} from "ekubo/libraries/CoreLib.sol";
import {FlashAccountantLib} from "ekubo/libraries/FlashAccountantLib.sol";
import {Locker} from "ekubo/types/locker.sol";
import {Ownable} from "solady/auth/Ownable.sol";

abstract contract FeeComputer {
    function computeFee(address token, uint128 amount) public virtual returns (uint128 fee);
}

abstract contract FeeApplier {
    function _applyFee(address token, uint128 fee) internal virtual;
}

abstract contract Integrator is BaseForwardee, FeeComputer, FeeApplier {
    constructor(IFlashAccountant accountant) BaseForwardee(accountant) {}

    function handleForwardData(Locker, bytes memory data) internal override returns (bytes memory result) {
        (address token, uint128 amount) = abi.decode(data, (address, uint128));

        uint128 fee = computeFee(token, amount);
        _applyFee(token, fee);

        return abi.encode(fee);
    }

    function computeFee(address token, uint128 amount) public virtual override returns (uint128 fee);
    function _applyFee(address token, uint128 fee) internal virtual override;
}

abstract contract FixedFeeComputer is FeeComputer {
    uint128 public immutable feeX128;

    constructor(uint128 _feeX128) {
        feeX128 = _feeX128;
    }

    function computeFee(address, uint128 amount) public view virtual override returns (uint128 fee) {
        return computeFixedPointFee(amount, feeX128);
    }
}

abstract contract SavedBalanceFeeApplier is FeeApplier, Ownable, UsesCore, BaseLocker {
    using CoreLib for ICore;

    address private constant _SAVED_BALANCE_TOKEN1 = address(type(uint160).max);
    bytes32 private constant _SAVED_BALANCE_SALT = 0;

    constructor(ICore core, address initialOwner) UsesCore(core) BaseLocker(core) {
        _initializeOwner(initialOwner);
    }

    function savedBalance(address token) external view returns (uint128 amount) {
        (amount,) = CORE.savedBalances(address(this), token, _SAVED_BALANCE_TOKEN1, _SAVED_BALANCE_SALT);
    }

    function withdrawSavedBalance(address token) external onlyOwner returns (uint128 amount) {
        amount = abi.decode(lock(abi.encode(token)), (uint128));
    }

    function handleLockData(uint256, bytes memory data) internal override returns (bytes memory result) {
        unchecked {
            address token = abi.decode(data, (address));

            (uint128 amount,) = CORE.savedBalances(address(this), token, _SAVED_BALANCE_TOKEN1, _SAVED_BALANCE_SALT);

            if (amount != 0) {
                CORE.updateSavedBalances(token, _SAVED_BALANCE_TOKEN1, _SAVED_BALANCE_SALT, -int256(uint256(amount)), 0);
                FlashAccountantLib.withdraw(ACCOUNTANT, token, owner(), amount);
            }

            return abi.encode(amount);
        }
    }

    function _applyFee(address token, uint128 fee) internal virtual override {
        CORE.updateSavedBalances(token, _SAVED_BALANCE_TOKEN1, _SAVED_BALANCE_SALT, int256(uint256(fee)), 0);
    }
}

contract FixedSavedBalanceIntegrator is Integrator, FixedFeeComputer, SavedBalanceFeeApplier {
    constructor(ICore core, address initialOwner, uint128 _feeX128)
        Integrator(core)
        FixedFeeComputer(_feeX128)
        SavedBalanceFeeApplier(core, initialOwner)
    {}

    function computeFee(
        address /*token*/,
        uint128 amount
    )
        public
        view
        override(Integrator, FixedFeeComputer)
        returns (uint128 fee)
    {
        return FixedFeeComputer.computeFee(address(0), amount);
    }

    function _applyFee(address token, uint128 fee) internal override(Integrator, SavedBalanceFeeApplier) {
        SavedBalanceFeeApplier._applyFee(token, fee);
    }
}

function computeFixedPointFee(uint128 amount, uint128 feeX128) pure returns (uint128 fee) {
    if (feeX128 != 0) {
        assembly ("memory-safe") {
            fee := div(shl(128, amount), feeX128)
        }
    }
}
