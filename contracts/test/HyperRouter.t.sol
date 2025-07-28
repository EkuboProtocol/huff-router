// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {
    CORE_ADDRESS,
    HyperRouterLib,
    IHyperRouter,
    MEV_RESIST_ADDRESS,
    ORACLE_ADDRESS,
    TWAMM_ADDRESS
} from "../src/HyperRouter.sol";

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

    struct SuccessCase {
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

    struct RefundETHNonPayableCase {
        bytes data;
    }

    struct SdkCases {
        SuccessCase[] success;
        RefundETHNonPayableCase refundEthNonPayable;
    }

    error SuccessCaseError(SuccessCase s, string err);
    error CoreOnly();

    bytes32 private constant _SAVED_BALANCE_SALT = keccak256("HYPER_ROUTER");
    // cast keccak "HyperRouterTest#DISABLE_RECEIVE_SLOT"
    uint256 private constant _DISABLE_RECEIVE_SLOT = 0x27095381dc94d25f5c191482faa73780fd308183456a62f43e8833e46ea4a541;
    uint256 private constant _EXACT_OUT_DEAL_AMOUNT = type(uint128).max / 2;

    address private immutable payer = address(this);

    ICore private constant CORE = ICore(CORE_ADDRESS);
    IHyperRouter private hyperRouter;

    modifier disableReceive() {
        assembly ("memory-safe") {
            tstore(_DISABLE_RECEIVE_SLOT, 1)
        }

        _;

        assembly ("memory-safe") {
            tstore(_DISABLE_RECEIVE_SLOT, 0)
        }
    }

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("mainnet"), 22968156);

        hyperRouter = HyperRouterLib.deploy(vm);

        // TODO Use snapshots
    }

    function test_MinimalCalldata() external {
        (bool success, bytes memory data) = address(hyperRouter).call(hex"00000000010000000001");
        assertTrue(success);

        HyperRouterLib.Returndata memory returndata = HyperRouterLib.decodeReturndata(data);

        assertEq(returndata.calculatedAmount, 0);
        assertEq(returndata.integrationFee, 0);
    }

    function testRevert_LockedCoreOnly() external {
        vm.expectRevert(IHyperRouter.CoreOnly.selector);
        hyperRouter.locked(0);
    }

    function testRevert_PayCallbackCoreOnly() external {
        vm.expectRevert(IHyperRouter.CoreOnly.selector);
        hyperRouter.payCallback(0, NATIVE_TOKEN_ADDRESS);
    }

    function test_SdkCases() external {
        string[] memory inputs = new string[](6);
        inputs[0] = "npm";
        inputs[1] = "--prefix";
        inputs[2] = "../sdk/";
        inputs[3] = "--silent";
        inputs[4] = "run";
        inputs[5] = "generate-testdata";

        executeSdkCases(abi.decode(vm.ffi(inputs), (SdkCases)));
    }

    // public because we need this function to exist in the ABI for the TS calldata generation
    function executeSdkCases(SdkCases memory sdkCases) public {
        for (uint256 i = 0; i < sdkCases.success.length; i++) {
            SuccessCase memory s = sdkCases.success[i];

            try this.executeSuccessCase(s) {}
            catch (bytes memory data) {
                revert SuccessCaseError({s: s, err: string(data)});
            }

            setUp();
        }

        _testRevert_RefundETHNonPayable(sdkCases.refundEthNonPayable);
    }

    function executeSuccessCase(SuccessCase memory t) external {
        (address tokenIn, address tokenOut, address integratorToken) = t.isExactOut
            ? (t.calculatedToken, t.specifiedToken, t.specifiedToken)
            : (t.specifiedToken, t.calculatedToken, t.calculatedToken);

        uint256 value;
        uint256 dealAmount = t.isExactOut ? _EXACT_OUT_DEAL_AMOUNT : t.totalSpecified;

        if (tokenIn == NATIVE_TOKEN_ADDRESS) {
            vm.deal(payer, dealAmount);

            if (!t.delegatecall) {
                value = dealAmount;
            }
        } else {
            deal(tokenIn, payer, dealAmount);
            ERC20(tokenIn).approve(address(hyperRouter), dealAmount);
        }

        address recipient = t.recipient == address(0) ? payer : t.recipient;

        (uint256 payerBalanceBefore, uint256 recipientBalanceBefore, uint128 integratorBalanceBefore) =
            (_balanceOf(payer, tokenIn), _balanceOf(recipient, tokenOut), _savedBalance(t.integrator, integratorToken));

        bytes memory result = t.delegatecall
            ? LibCall.delegateCallContract(address(hyperRouter), t.data)
            : LibCall.callContract(address(hyperRouter), value, t.data);
        vm.snapshotGasLastCall(t.name);

        HyperRouterLib.Returndata memory returndata = HyperRouterLib.decodeReturndata(result);

        assertNotEq(returndata.calculatedAmount, 0);

        if (t.integrator != address(0)) {
            assertNotEq(returndata.integrationFee, 0, "integration fee should be non-zero");
        }

        (uint256 payerBalanceAfter, uint256 recipientBalanceAfter, uint128 integratorBalanceAfter) =
            (_balanceOf(payer, tokenIn), _balanceOf(recipient, tokenOut), _savedBalance(t.integrator, integratorToken));

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

    function _testRevert_RefundETHNonPayable(RefundETHNonPayableCase memory c) private disableReceive {
        vm.deal(payer, _EXACT_OUT_DEAL_AMOUNT);

        vm.expectRevert(IHyperRouter.ETHTransferFailed.selector);
        LibCall.callContract(address(hyperRouter), _EXACT_OUT_DEAL_AMOUNT, c.data);
    }

    function _balanceOf(address owner, address token) private view returns (uint256 balance) {
        if (token == NATIVE_TOKEN_ADDRESS) {
            return owner.balance;
        } else {
            return ERC20(token).balanceOf(owner);
        }
    }

    function _savedBalance(address owner, address token) private view returns (uint128 balance) {
        return CORE.savedBalances(owner, token, _SAVED_BALANCE_SALT);
    }

    receive() external payable {
        bool reject;

        assembly ("memory-safe") {
            reject := tload(_DISABLE_RECEIVE_SLOT)
        }

        if (reject) {
            revert();
        }
    }

    fallback() external {
        require(msg.sender == CORE_ADDRESS, CoreOnly());

        bytes memory result = LibCall.delegateCallContract(address(hyperRouter), msg.data);
        uint256 len = result.length;

        assembly ("memory-safe") {
            let free := mload(0x40)
            mcopy(free, add(result, 0x20), len)
            return(free, len)
        }
    }
}
