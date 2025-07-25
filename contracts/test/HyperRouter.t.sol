// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {CORE_ADDRESS, HyperRouter, MEV_RESIST_ADDRESS, ORACLE_ADDRESS, TWAMM_ADDRESS} from "../src/HyperRouter.sol";

import {ICore} from "ekubo/interfaces/ICore.sol";
import {CoreLib} from "ekubo/libraries/CoreLib.sol";
import {NATIVE_TOKEN_ADDRESS} from "ekubo/src/math/constants.sol";
import {MAX_SQRT_RATIO_RAW, MIN_SQRT_RATIO_RAW} from "ekubo/src/types/sqrtRatio.sol";
import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/tokens/ERC20.sol";
import {LibBit} from "solady/utils/LibBit.sol";
import {LibBytes} from "solady/utils/LibBytes.sol";
import {LibCall} from "solady/utils/LibCall.sol";
import {SafeCastLib} from "solady/utils/SafeCastLib.sol";

contract HyperRouterTest is Test {
    using CoreLib for ICore;

    struct TestCase {
        bytes data;
        address specifiedToken;
        address calculatedToken;
        bool isExactOut;
        bool delegatecall;
        uint256 totalSpecified;
        address recipient;
        address integrator;
        string name;
    }

    error TestCaseError(TestCase testCase, string err);
    error CoreOnly();

    bytes32 constant SAVED_BALANCE_SALT = keccak256("HYPER_ROUTER");
    uint256 constant EXACT_OUT_DEAL_AMOUNT = type(uint128).max / 2;

    ICore constant CORE = ICore(CORE_ADDRESS);
    address hyperRouter;

    modifier setUpFork() {
        vm.createSelectFork(vm.rpcUrl("mainnet"), 22968156);

        hyperRouter = HyperRouter.deploy(vm);

        _;
    }

    function balanceOf(address owner, address token) private view returns (uint256 balance) {
        if (token == NATIVE_TOKEN_ADDRESS) {
            return owner.balance;
        } else {
            return ERC20(token).balanceOf(owner);
        }
    }

    function savedBalance(address owner, address token) private view returns (uint128 balance) {
        return CORE.savedBalances(owner, token, SAVED_BALANCE_SALT);
    }

    function testSdkCases() external {
        string[] memory inputs = new string[](6);
        inputs[0] = "npm";
        inputs[1] = "--prefix";
        inputs[2] = "../sdk/";
        inputs[3] = "--silent";
        inputs[4] = "run";
        inputs[5] = "generate-testdata";

        executeSdkCases(abi.decode(vm.ffi(inputs), (TestCase[])));
    }

    function executeSdkCases(TestCase[] memory testCases) public {
        for (uint256 i = 0; i < testCases.length; i++) {
            TestCase memory t = testCases[i];

            try this.executeSdkCase(t) {}
            catch (bytes memory data) {
                revert TestCaseError({testCase: t, err: string(data)});
            }
        }
    }

    function testMinimalCalldata() external setUpFork {
        (bool success, bytes memory data) = hyperRouter.call(hex"00000000010000000001");
        assertTrue(success);

        HyperRouter.Returndata memory returndata = HyperRouter.decodeReturndata(data);

        assertEq(returndata.calculatedAmount, 0);
        assertEq(returndata.integrationFee, 0);
    }

    function executeSdkCase(TestCase memory t) public setUpFork {
        (address tokenIn, address tokenOut, address integratorToken) = t.isExactOut
            ? (t.calculatedToken, t.specifiedToken, t.specifiedToken)
            : (t.specifiedToken, t.calculatedToken, t.calculatedToken);

        uint256 value;

        uint256 dealAmount = t.isExactOut ? EXACT_OUT_DEAL_AMOUNT : t.totalSpecified;

        address payer = address(this);

        if (tokenIn == NATIVE_TOKEN_ADDRESS) {
            vm.deal(payer, dealAmount);

            if (!t.delegatecall) {
                value = dealAmount;
            }
        } else {
            deal(tokenIn, payer, dealAmount);
            ERC20(tokenIn).approve(hyperRouter, dealAmount);
        }

        address recipient = t.recipient == address(0) ? payer : t.recipient;

        (uint256 payerBalanceBefore, uint256 recipientBalanceBefore, uint128 integratorBalanceBefore) =
            (balanceOf(payer, tokenIn), balanceOf(recipient, tokenOut), savedBalance(t.integrator, integratorToken));

        (bool success, bytes memory result) =
            t.delegatecall ? hyperRouter.delegatecall(t.data) : hyperRouter.call{value: value}(t.data);
        vm.snapshotGasLastCall(t.name);
        assertTrue(success, "call should succeed");

        HyperRouter.Returndata memory returndata = HyperRouter.decodeReturndata(result);

        assertNotEq(returndata.calculatedAmount, 0);

        if (t.integrator != address(0)) {
            assertNotEq(returndata.integrationFee, 0, "integration fee should be non-zero");
        }

        (uint256 payerBalanceAfter, uint256 recipientBalanceAfter, uint128 integratorBalanceAfter) =
            (balanceOf(payer, tokenIn), balanceOf(recipient, tokenOut), savedBalance(t.integrator, integratorToken));

        (int256 expectedTokenInDiff, int256 expectedTokenOutDiff) = t.isExactOut
            ? (
                -SafeCastLib.toInt256(returndata.calculatedAmount),
                SafeCastLib.toInt256(t.totalSpecified) - int256(uint256(returndata.integrationFee))
            )
            : (-SafeCastLib.toInt256(t.totalSpecified), SafeCastLib.toInt256(returndata.calculatedAmount));

        if (t.specifiedToken == t.calculatedToken && payer == recipient) {
            expectedTokenInDiff += expectedTokenOutDiff;
            expectedTokenOutDiff = expectedTokenInDiff;
        }

        assertEq(
            expectedTokenInDiff,
            SafeCastLib.toInt256(payerBalanceAfter) - SafeCastLib.toInt256(payerBalanceBefore),
            "unexpected tokenIn difference"
        );
        assertEq(
            expectedTokenOutDiff,
            SafeCastLib.toInt256(recipientBalanceAfter) - SafeCastLib.toInt256(recipientBalanceBefore),
            "unexpected tokenOut difference"
        );
        assertEq(
            returndata.integrationFee,
            integratorBalanceAfter - integratorBalanceBefore,
            "unexpected integration fee difference"
        );
    }

    receive() external payable {}

    fallback() external {
        require(msg.sender == CORE_ADDRESS, CoreOnly());

        bytes memory result = LibCall.delegateCallContract(hyperRouter, msg.data);
        uint256 len = result.length;

        assembly ("memory-safe") {
            let free := mload(0x40)
            mcopy(free, add(result, 0x20), len)
            return(free, len)
        }
    }
}
