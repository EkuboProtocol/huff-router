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
import {console} from "forge-std/console.sol";
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
        uint256 overrideBlockNumber;
        uint256 overrideTimestamp;
        string name;
    }

    struct RefundETHNonPayableCase {
        bytes data;
    }

    struct SlippageCheckFailedCase {
        bytes data;
        bool isExactOut;
        uint256 calculatedAmountThreshold;
    }

    struct SdkCases {
        SuccessCase[] success;
        RefundETHNonPayableCase refundEthNonPayable;
        SlippageCheckFailedCase[] slippageCheckFailed;
    }

    error SuccessCaseError(SuccessCase c, bytes err);
    error CoreOnly();

    bytes32 private constant _SAVED_BALANCE_SALT = keccak256("HYPER_ROUTER");
    // cast keccak "HyperRouterTest#DISABLE_RECEIVE_SLOT"
    uint256 private constant _DISABLE_RECEIVE_SLOT = 0x27095381dc94d25f5c191482faa73780fd308183456a62f43e8833e46ea4a541;
    uint256 private constant _EXACT_OUT_DEAL_AMOUNT = type(uint128).max / 2;

    string private _MAINNET_RPC_URL_OR_ALIAS = vm.envString("MAINNET_RPC_URL_OR_ALIAS");
    uint256 private constant _DEFAULT_FORK_BLOCK_NUMBER = 23287720;

    address private immutable _payer = address(this);
    IHyperRouter private immutable _hyperRouter;

    ICore private constant _CORE = ICore(CORE_ADDRESS);

    constructor() {
        _hyperRouter = HyperRouterLib.deploy(vm);
        vm.makePersistent(address(_hyperRouter));
    }

    modifier disableReceive() {
        assembly ("memory-safe") {
            tstore(_DISABLE_RECEIVE_SLOT, 1)
        }

        _;

        assembly ("memory-safe") {
            tstore(_DISABLE_RECEIVE_SLOT, 0)
        }
    }

    function selectFork(uint256 blockNumber) private {
        vm.createSelectFork(_MAINNET_RPC_URL_OR_ALIAS, blockNumber == 0 ? _DEFAULT_FORK_BLOCK_NUMBER : blockNumber);
    }

    function test_ContractSize() external view {
        address hyperRouterAddr = address(_hyperRouter);
        uint256 codeSize;
        assembly ("memory-safe") {
            codeSize := extcodesize(hyperRouterAddr)
        }

        console.log(codeSize);

        assertLe(codeSize, 24_576);
    }

    function test_MinimalCalldata() external {
        selectFork(0);

        (bool success, bytes memory data) = address(_hyperRouter).call(hex"00000000010000000001");
        assertTrue(success);

        HyperRouterLib.Returndata memory returndata = HyperRouterLib.decodeReturndata(data);

        assertEq(returndata.calculatedAmount, 0);
        assertEq(returndata.integrationFee, 0);
    }

    function testRevert_LockedCoreOnly() external {
        vm.expectRevert(IHyperRouter.CoreOnly.selector);
        _hyperRouter.locked(0);
    }

    function testRevert_PayCallbackCoreOnly() external {
        vm.expectRevert(IHyperRouter.CoreOnly.selector);
        _hyperRouter.payCallback(0, NATIVE_TOKEN_ADDRESS);
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
            SuccessCase memory c = sdkCases.success[i];

            try this._test_Success(c) {}
            catch (bytes memory data) {
                revert SuccessCaseError({c: c, err: data});
            }
        }

        for (uint256 i = 0; i < sdkCases.slippageCheckFailed.length; i++) {
            selectFork(0);
            _testRevert_SlippageCheckFailed(sdkCases.slippageCheckFailed[i]);
        }

        selectFork(0);
        _testRevert_RefundETHNonPayable(sdkCases.refundEthNonPayable);
    }

    function _test_Success(SuccessCase memory t) external {
        selectFork(t.overrideBlockNumber);

        uint256 timestampBefore = vm.getBlockTimestamp();

        if (t.overrideTimestamp != 0) {
            vm.warp(t.overrideTimestamp);
        }

        (address tokenIn, address tokenOut, address integratorToken) = t.isExactOut
            ? (t.calculatedToken, t.specifiedToken, t.specifiedToken)
            : (t.specifiedToken, t.calculatedToken, t.calculatedToken);

        uint256 value;
        uint256 dealAmount = t.isExactOut ? _EXACT_OUT_DEAL_AMOUNT : t.totalSpecified;

        if (tokenIn == NATIVE_TOKEN_ADDRESS) {
            vm.deal(_payer, dealAmount);

            if (!t.delegatecall) {
                value = dealAmount;
            }
        } else {
            deal(tokenIn, _payer, dealAmount);
            ERC20(tokenIn).approve(address(_hyperRouter), dealAmount);
        }

        address recipient = t.recipient == address(0) ? _payer : t.recipient;

        (uint256 payerBalanceBefore, uint256 recipientBalanceBefore, uint128 integratorBalanceBefore) =
            (_balanceOf(_payer, tokenIn), _balanceOf(recipient, tokenOut), _savedBalance(t.integrator, integratorToken));

        bytes memory result = t.delegatecall
            ? LibCall.delegateCallContract(address(_hyperRouter), t.data)
            : LibCall.callContract(address(_hyperRouter), value, t.data);
        vm.snapshotGasLastCall(t.name);

        HyperRouterLib.Returndata memory returndata = HyperRouterLib.decodeReturndata(result);

        assertNotEq(returndata.calculatedAmount, 0);

        if (t.integrator != address(0)) {
            assertNotEq(returndata.integrationFee, 0, "integration fee should be non-zero");
        }

        (uint256 payerBalanceAfter, uint256 recipientBalanceAfter, uint128 integratorBalanceAfter) =
            (_balanceOf(_payer, tokenIn), _balanceOf(recipient, tokenOut), _savedBalance(t.integrator, integratorToken));

        (int256 expectedTokenInDiff, int256 expectedTokenOutDiff) = t.isExactOut
            ? (
                -SafeCastLib.toInt256(returndata.calculatedAmount),
                SafeCastLib.toInt256(t.totalSpecified) - int256(uint256(returndata.integrationFee))
            )
            : (-SafeCastLib.toInt256(t.totalSpecified), SafeCastLib.toInt256(returndata.calculatedAmount));

        if (t.specifiedToken == t.calculatedToken && _payer == recipient) {
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

        vm.warp(timestampBefore);
    }

    function _testRevert_SlippageCheckFailed(SlippageCheckFailedCase memory c) private {
        (bool success, bytes memory result) = address(_hyperRouter).call(c.data);
        assertFalse(success);

        assertEq(IHyperRouter.SlippageCheckFailed.selector, bytes4(result));

        uint256 calculatedAmount = abi.decode(LibBytes.slice(result, 4), (uint256));

        if (c.isExactOut) {
            assertLt(c.calculatedAmountThreshold, calculatedAmount);
        } else {
            assertGt(c.calculatedAmountThreshold, calculatedAmount);
        }
    }

    function _testRevert_RefundETHNonPayable(RefundETHNonPayableCase memory c) private disableReceive {
        vm.deal(_payer, _EXACT_OUT_DEAL_AMOUNT);

        vm.expectRevert(IHyperRouter.ETHTransferFailed.selector);
        LibCall.callContract(address(_hyperRouter), _EXACT_OUT_DEAL_AMOUNT, c.data);
    }

    function _balanceOf(address owner, address token) private view returns (uint256 balance) {
        if (token == NATIVE_TOKEN_ADDRESS) {
            return owner.balance;
        } else {
            return ERC20(token).balanceOf(owner);
        }
    }

    function _savedBalance(address owner, address token) private view returns (uint128 balance) {
        return _CORE.savedBalances(owner, token, _SAVED_BALANCE_SALT);
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

        bytes memory result = LibCall.delegateCallContract(address(_hyperRouter), msg.data);
        uint256 len = result.length;

        assembly ("memory-safe") {
            let free := mload(0x40)
            mcopy(free, add(result, 0x20), len)
            return(free, len)
        }
    }
}
