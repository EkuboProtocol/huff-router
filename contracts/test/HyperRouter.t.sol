// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {HyperRouterLib, IHyperRouter} from "../src/HyperRouter.sol";
import {CORE_ADDRESS, POSITIONS_ADDRESS} from "../src/addresses.sol";

import {ICore} from "ekubo/interfaces/ICore.sol";
import {CoreLib} from "ekubo/libraries/CoreLib.sol";
import {NATIVE_TOKEN_ADDRESS} from "ekubo/math/constants.sol";
import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";
import {ERC20} from "solady/tokens/ERC20.sol";
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

    struct RefundEthNonPayableCase {
        bytes data;
    }

    struct SlippageCheckFailedCase {
        bytes data;
        bool isExactOut;
        uint256 calculatedAmountThreshold;
    }

    struct SdkCases {
        SuccessCase[] success;
        RefundEthNonPayableCase refundEthNonPayable;
        SlippageCheckFailedCase[] slippageCheckFailed;
    }

    error SuccessCaseError(SuccessCase c, bytes err);
    error CoreOnly();

    // cast keccak "HyperRouterTest#DISABLE_RECEIVE_SLOT"
    uint256 private constant _DISABLE_RECEIVE_SLOT = 0x27095381dc94d25f5c191482faa73780fd308183456a62f43e8833e46ea4a541;
    uint256 private constant _EXACT_OUT_DEAL_AMOUNT = type(uint128).max / 2;
    uint256 private constant _MAX_CODE_SIZE = 24_576; // https://eips.ethereum.org/EIPS/eip-170
    uint256 private constant _FOUNDRY_CHAIN_ID = 31337;

    string private _rpcUrlOrAlias = vm.envString("RPC_URL_OR_ALIAS");

    address private immutable _PAYER = address(this);
    IHyperRouter private immutable _HYPER_ROUTER;
    uint256 private immutable _forkBlockNumber;

    ICore private constant _CORE = ICore(CORE_ADDRESS);

    constructor() {
        assertEq(block.chainid, _FOUNDRY_CHAIN_ID);

        // This deploys it using the tokens set for the development chainid
        _HYPER_ROUTER = HyperRouterLib.deploy(vm);
        vm.makePersistent(address(_HYPER_ROUTER));

        vm.createSelectFork(_rpcUrlOrAlias, uint256(0));

        uint256 chainid = block.chainid;

        if (chainid == 11155111) {
            _forkBlockNumber = 9524989;
        } else {
            revert("unknown chainid");
        }

        vm.rollFork(_forkBlockNumber);
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
        //vm.createSelectFork(_rpcUrlOrAlias, blockNumber == 0 ? _DEFAULT_FORK_BLOCK_NUMBER : blockNumber);
    }

    function test_ContractSize() external view {
        address hyperRouterAddr = address(_HYPER_ROUTER);
        uint256 codeSize;
        assembly ("memory-safe") {
            codeSize := extcodesize(hyperRouterAddr)
        }

        console.log(codeSize);

        assertLe(codeSize, _MAX_CODE_SIZE);
    }

    function test_MinimalCalldata() external {
        (bool success, bytes memory data) = address(_HYPER_ROUTER).call(hex"00000000010000000001");
        assertTrue(success);

        HyperRouterLib.SwapReturndata memory returndata = HyperRouterLib.decodeSwapReturndata(data);

        assertEq(returndata.calculatedAmount, 0);
        assertEq(returndata.integrationFee, 0);
    }

    function testRevert_LockedCoreOnly() external {
        vm.expectRevert(IHyperRouter.CoreOnly.selector);
        _HYPER_ROUTER.locked_6416899205(0);
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

            try this._testSuccess(c) {}
            catch (bytes memory data) {
                revert SuccessCaseError({c: c, err: data});
            }
        }

        for (uint256 i = 0; i < sdkCases.slippageCheckFailed.length; i++) {
            selectFork(0);
            _testRevertSlippageCheckFailed(sdkCases.slippageCheckFailed[i]);
        }

        selectFork(0);
        _testRevertRefundEthNonPayable(sdkCases.refundEthNonPayable);
    }

    function _testSuccess(SuccessCase memory t) external {
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
            vm.deal(_PAYER, dealAmount);

            if (!t.delegatecall) {
                value = dealAmount;
            }
        } else {
            deal(tokenIn, _PAYER, dealAmount);
            ERC20(tokenIn).approve(address(_HYPER_ROUTER), dealAmount);
        }

        address recipient = t.recipient == address(0) ? _PAYER : t.recipient;

        (uint256 payerBalanceBefore, uint256 recipientBalanceBefore, uint128 integratorBalanceBefore) = (
            _balanceOf(_PAYER, tokenIn),
            _balanceOf(recipient, tokenOut),
            _unclaimedIntegrationFees(t.integrator, integratorToken)
        );

        bytes memory result = t.delegatecall
            ? LibCall.delegateCallContract(address(_HYPER_ROUTER), t.data)
            : LibCall.callContract(address(_HYPER_ROUTER), value, t.data);
        vm.snapshotGasLastCall(t.name);

        HyperRouterLib.SwapReturndata memory returndata = HyperRouterLib.decodeSwapReturndata(result);

        assertNotEq(returndata.calculatedAmount, 0);

        if (t.integrator != address(0)) {
            assertNotEq(returndata.integrationFee, 0, "integration fee should be non-zero");
        }

        (uint256 payerBalanceAfter, uint256 recipientBalanceAfter, uint128 integratorBalanceAfter) = (
            _balanceOf(_PAYER, tokenIn),
            _balanceOf(recipient, tokenOut),
            _unclaimedIntegrationFees(t.integrator, integratorToken)
        );

        (int256 expectedTokenInDiff, int256 expectedTokenOutDiff) = t.isExactOut
            ? (
                -SafeCastLib.toInt256(returndata.calculatedAmount),
                SafeCastLib.toInt256(t.totalSpecified) - int256(uint256(returndata.integrationFee))
            )
            : (-SafeCastLib.toInt256(t.totalSpecified), SafeCastLib.toInt256(returndata.calculatedAmount));

        if (t.specifiedToken == t.calculatedToken && _PAYER == recipient) {
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

    function _testRevertSlippageCheckFailed(SlippageCheckFailedCase memory c) private {
        (bool success, bytes memory result) = address(_HYPER_ROUTER).call(c.data);
        assertFalse(success);

        assertEq(IHyperRouter.SlippageCheckFailed.selector, bytes4(result));

        uint256 calculatedAmount = abi.decode(LibBytes.slice(result, 4), (uint256));

        if (c.isExactOut) {
            assertLt(c.calculatedAmountThreshold, calculatedAmount);
        } else {
            assertGt(c.calculatedAmountThreshold, calculatedAmount);
        }
    }

    function _testRevertRefundEthNonPayable(RefundEthNonPayableCase memory c) private disableReceive {
        vm.deal(_PAYER, _EXACT_OUT_DEAL_AMOUNT);

        vm.expectRevert(IHyperRouter.ETHTransferFailed.selector);
        LibCall.callContract(address(_HYPER_ROUTER), _EXACT_OUT_DEAL_AMOUNT, c.data);
    }

    function _balanceOf(address owner, address token) private view returns (uint256 balance) {
        if (token == NATIVE_TOKEN_ADDRESS) {
            return owner.balance;
        } else {
            return ERC20(token).balanceOf(owner);
        }
    }

    function _unclaimedIntegrationFees(address owner, address token) private view returns (uint128 balance) {
        (balance,) = _CORE.savedBalances(
            address(_HYPER_ROUTER), token, address(type(uint160).max), bytes32(uint256(uint160(owner)))
        );
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

        bytes memory result = LibCall.delegateCallContract(address(_HYPER_ROUTER), msg.data);
        uint256 len = result.length;

        assembly ("memory-safe") {
            let free := mload(0x40)
            mcopy(free, add(result, 0x20), len)
            return(free, len)
        }
    }
}
