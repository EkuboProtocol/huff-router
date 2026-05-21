// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.33;

import {FixedSavedBalanceIntegrator} from "../src/Integrator.sol";
import {CORE_ADDRESS} from "../src/addresses.sol";

import {BaseLocker} from "ekubo/base/BaseLocker.sol";
import {ICore} from "ekubo/interfaces/ICore.sol";
import {FlashAccountantLib} from "ekubo/libraries/FlashAccountantLib.sol";
import {NATIVE_TOKEN_ADDRESS} from "ekubo/math/constants.sol";
import {Test} from "forge-std/Test.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";
import {Ownable} from "solady/auth/Ownable.sol";
import {ERC20} from "solady/tokens/ERC20.sol";

contract TestToken is ERC20 {
    function name() public view virtual override returns (string memory) {
        return "Test Token";
    }

    function symbol() public view virtual override returns (string memory) {
        return "TEST";
    }
}

contract ForwardingLocker is BaseLocker {
    constructor(ICore core) BaseLocker(core) {}

    function accrue(FixedSavedBalanceIntegrator integrator, address token, uint128 amount) external payable {
        if (token == NATIVE_TOKEN_ADDRESS) {
            require(msg.value == amount, "native value mismatch");
        } else {
            require(msg.value == 0, "unexpected native value");
        }

        lock(abi.encode(integrator, token, amount));
    }

    function handleLockData(uint256, bytes memory data) internal override returns (bytes memory result) {
        (FixedSavedBalanceIntegrator integrator, address token, uint128 amount) =
            abi.decode(data, (FixedSavedBalanceIntegrator, address, uint128));

        if (token == NATIVE_TOKEN_ADDRESS) {
            (bool success,) = payable(address(ACCOUNTANT)).call{value: amount}("");
            require(success, "native payment failed");
        } else {
            FlashAccountantLib.pay(ACCOUNTANT, token, amount);
        }

        FlashAccountantLib.forward(ACCOUNTANT, address(integrator), abi.encode(token, amount));

        return "";
    }

    receive() external payable {}
}

contract FixedSavedBalanceIntegratorTest is Test {
    uint128 private constant _AMOUNT = 1 ether;
    address private constant _TOKEN = 0x1111111111111111111111111111111111111111;

    ICore private constant CORE = ICore(CORE_ADDRESS);

    FixedSavedBalanceIntegrator private integrator;
    ForwardingLocker private locker;
    address private owner = makeAddr("owner");
    address private other = makeAddr("other");

    function setUp() public {
        deployCodeTo("v3-artifacts/Core.json", CORE_ADDRESS);
        deployCodeTo("IntegrationFeeController.t.sol:TestToken", _TOKEN);

        integrator = new FixedSavedBalanceIntegrator(CORE, owner, type(uint128).max);
        locker = new ForwardingLocker(CORE);
    }

    function test_forwardedLockStoresERC20AmountInSavedBalance() external {
        _accrue(_TOKEN, _AMOUNT);

        assertEq(integrator.savedBalance(_TOKEN), _AMOUNT);
        assertEq(IERC20(_TOKEN).balanceOf(address(CORE)), _AMOUNT);
    }

    function test_ownerCanWithdrawERC20SavedBalance() external {
        _accrue(_TOKEN, _AMOUNT);

        uint256 ownerBalanceBefore = IERC20(_TOKEN).balanceOf(owner);

        vm.prank(owner);
        uint128 withdrawn = integrator.withdrawSavedBalance(_TOKEN);

        assertEq(withdrawn, _AMOUNT);
        assertEq(IERC20(_TOKEN).balanceOf(owner) - ownerBalanceBefore, _AMOUNT);
        assertEq(integrator.savedBalance(_TOKEN), 0);
        assertEq(IERC20(_TOKEN).balanceOf(address(CORE)), 0);
    }

    function test_ownerCanWithdrawNativeSavedBalance() external {
        _accrue(NATIVE_TOKEN_ADDRESS, _AMOUNT);

        uint256 ownerBalanceBefore = owner.balance;

        vm.prank(owner);
        uint128 withdrawn = integrator.withdrawSavedBalance(NATIVE_TOKEN_ADDRESS);

        assertEq(withdrawn, _AMOUNT);
        assertEq(owner.balance - ownerBalanceBefore, _AMOUNT);
        assertEq(integrator.savedBalance(NATIVE_TOKEN_ADDRESS), 0);
        assertEq(address(CORE).balance, 0);
    }

    function testRevert_nonOwnerCannotWithdrawSavedBalance() external {
        _accrue(_TOKEN, _AMOUNT);

        vm.prank(other);
        vm.expectRevert(Ownable.Unauthorized.selector);
        integrator.withdrawSavedBalance(_TOKEN);
    }

    function _accrue(address token, uint128 amount) private {
        if (token == NATIVE_TOKEN_ADDRESS) {
            vm.deal(address(this), amount);
            locker.accrue{value: amount}(integrator, token, amount);
        } else {
            deal(token, address(locker), amount);
            locker.accrue(integrator, token, amount);
        }
    }
}
