// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {HyperRouterLib, IHyperRouter} from "../src/HyperRouter.sol";
import {CORE_ADDRESS, MEV_CAPTURE_ADDRESS, ORACLE_ADDRESS, TWAMM_ADDRESS} from "../src/addresses.sol";

import {Positions} from "ekubo/Positions.sol";
import {ICore} from "ekubo/interfaces/ICore.sol";
import {IPositions} from "ekubo/interfaces/IPositions.sol";
import {CoreLib} from "ekubo/libraries/CoreLib.sol";
import {CoreStorageLayout} from "ekubo/libraries/CoreStorageLayout.sol";
import {NATIVE_TOKEN_ADDRESS} from "ekubo/math/constants.sol";
import {PoolConfig} from "ekubo/types/poolConfig.sol";
import {PoolKey} from "ekubo/types/poolKey.sol";
import {StorageSlot} from "ekubo/types/storageSlot.sol";
import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";
import {ERC20} from "solady/tokens/ERC20.sol";
import {LibBytes} from "solady/utils/LibBytes.sol";
import {LibCall} from "solady/utils/LibCall.sol";
import {SafeCastLib} from "solady/utils/SafeCastLib.sol";

contract TestToken is ERC20 {
    function name() public view virtual override returns (string memory) {
        return "Test Token";
    }

    function symbol() public view virtual override returns (string memory) {
        return "Test";
    }
}

contract HyperRouterTest is Test {
    using CoreLib for *;

    struct SuccessCase {
        bytes data;
        PoolKey[] poolKeys;

        address specifiedToken;
        address calculatedToken;
        uint256 totalSpecified;

        bool isExactOut;

        address recipient;
        address integrator;

        string name;
    }

    struct RefundNativeNonPayableCase {
        bytes data;
        PoolKey[] poolKeys;
    }

    struct SlippageCheckFailedCase {
        bytes data;
        PoolKey[] poolKeys;
        bool isExactOut;
        uint256 calculatedAmountThreshold;
    }

    struct MinimalCalldataCase {
        bytes data;
        PoolKey poolKey;
    }

    struct SdkCases {
        SuccessCase[] success;
        RefundNativeNonPayableCase refundNativeNonPayable;
        SlippageCheckFailedCase[] slippageCheckFailed;
        MinimalCalldataCase minimalCalldata;
    }

    uint128 private constant _INTEGRATION_FEE_AMOUNT = 1 ether;
    uint256 private constant _EXACT_OUT_APPROVE_AMOUNT = 10 ether;
    uint128 private constant _POSITION_AMOUNT = 100_000 ether;
    address private immutable _PAYER = address(this);

    // cast keccak "HyperRouterTest#DISABLE_RECEIVE_SLOT"
    uint256 private constant _DISABLE_RECEIVE_SLOT = 0x27095381dc94d25f5c191482faa73780fd308183456a62f43e8833e46ea4a541;
    uint256 private constant _MAX_CODE_SIZE = 24_576; // https://eips.ethereum.org/EIPS/eip-170
    uint256 private constant _MINIMAL_CALLDATA_LENGTH = 10;

    IHyperRouter private hyperRouter;
    ICore private constant CORE = ICore(CORE_ADDRESS);
    IPositions private positions;

    // TODO Also sync with SDK
    address private constant _ERC_20_FIRST_ADDRESS = 0x1111111111111111111111111111111111111111;
    address private constant _ERC_20_SECOND_ADDRESS = 0x2222222222222222222222222222222222222222;
    address private constant _TOKEN_WRAPPER_ADDRESS = 0x3333333333333333333333333333333333333333;

    function setUp() public {
        hyperRouter = HyperRouterLib.deploy(vm);

        deployCodeTo("v3-artifacts/Core.json", CORE_ADDRESS);
        deployCodeTo("v3-artifacts/MEVCapture.json", abi.encode(CORE_ADDRESS), MEV_CAPTURE_ADDRESS);
        deployCodeTo("v3-artifacts/Oracle.json", abi.encode(CORE_ADDRESS), ORACLE_ADDRESS);
        deployCodeTo("v3-artifacts/TWAMM.json", abi.encode(CORE_ADDRESS), TWAMM_ADDRESS);

        positions = new Positions(CORE, address(this), 0, 1);

        deployCodeTo("HyperRouter.t.sol:TestToken", _ERC_20_FIRST_ADDRESS);
        deployCodeTo("HyperRouter.t.sol:TestToken", _ERC_20_SECOND_ADDRESS);

        deployCodeTo(
            "v3-artifacts/TokenWrapper.json",
            abi.encode(CORE, _ERC_20_FIRST_ADDRESS, block.timestamp),
            _TOKEN_WRAPPER_ADDRESS
        );
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

    function test_ContractSize() external {
        uint256 codeSize = HyperRouterLib.initcodeSize(vm);
        console.log(codeSize);

        assertLe(codeSize, _MAX_CODE_SIZE);
    }

    function testRevert_LockedCoreOnly() external {
        vm.expectRevert(IHyperRouter.CoreOnly.selector);
        hyperRouter.locked_6416899205(0);
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
        uint256 snapshotId = vm.snapshotState();

        for (uint256 i = 0; i < sdkCases.success.length; i++) {
            test_Success(sdkCases.success[i]);
            vm.revertToState(snapshotId);
        }

        for (uint256 i = 0; i < sdkCases.slippageCheckFailed.length; i++) {
            testRevert_SlippageCheckFailed(sdkCases.slippageCheckFailed[i]);
            vm.revertToState(snapshotId);
        }

        testRevert_RefundNativeNonPayable(sdkCases.refundNativeNonPayable);
        vm.revertToState(snapshotId);

        test_MinimalCalldata(sdkCases.minimalCalldata);
    }

    function test_Success(SuccessCase memory c) private {
        _initializePools(c.poolKeys);

        (address tokenIn, address tokenOut, address integratorToken) = c.isExactOut
            ? (c.calculatedToken, c.specifiedToken, c.specifiedToken)
            : (c.specifiedToken, c.calculatedToken, c.calculatedToken);

        // Double the total specified amount because the testdata contains some unprofitable arbitrage swaps
        uint256 dealAmount = c.isExactOut ? _EXACT_OUT_APPROVE_AMOUNT : c.totalSpecified * 10;
        uint256 value = _approve(tokenIn, address(hyperRouter), dealAmount);

        address recipient = c.recipient == address(0) ? _PAYER : c.recipient;

        (uint256 payerBalanceBefore, uint256 recipientBalanceBefore, uint128 integratorBalanceBefore) = (
            _balanceOf(_PAYER, tokenIn),
            _balanceOf(recipient, tokenOut),
            _unclaimedIntegrationFees(c.integrator, integratorToken)
        );

        bytes memory result = LibCall.callContract(address(hyperRouter), value, c.data);
        vm.snapshotGasLastCall(c.name);

        HyperRouterLib.SwapReturndata memory returndata = HyperRouterLib.decodeSwapReturndata(result);

        assertNotEq(returndata.calculatedAmount, 0);

        if (c.integrator != address(0)) {
            assertNotEq(returndata.integrationFee, 0);
        }

        (uint256 payerBalanceAfter, uint256 recipientBalanceAfter, uint128 integratorBalanceAfter) = (
            _balanceOf(_PAYER, tokenIn),
            _balanceOf(recipient, tokenOut),
            _unclaimedIntegrationFees(c.integrator, integratorToken)
        );

        (int256 expectedTokenInDiff, int256 expectedTokenOutDiff) = c.isExactOut
            ? (
                -SafeCastLib.toInt256(returndata.calculatedAmount),
                SafeCastLib.toInt256(c.totalSpecified) - int256(uint256(returndata.integrationFee))
            )
            : (
                // Extra input won't be refunded if we're doing an exact-in swap
                -SafeCastLib.toInt256(tokenIn == NATIVE_TOKEN_ADDRESS ? dealAmount : c.totalSpecified),
                SafeCastLib.toInt256(returndata.calculatedAmount)
            );

        if (c.specifiedToken == c.calculatedToken && _PAYER == recipient) {
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

    function testRevert_SlippageCheckFailed(SlippageCheckFailedCase memory c) private {
        _initializePools(c.poolKeys);

        (bool success, bytes memory result) = address(hyperRouter).call(c.data);
        assertFalse(success, "success");

        // forge-lint: disable-next-line(unsafe-typecast)
        assertEq(IHyperRouter.SlippageCheckFailed.selector, bytes4(result), "error selector");

        uint256 calculatedAmount = abi.decode(LibBytes.slice(result, 4), (uint256));

        if (c.isExactOut) {
            assertLt(c.calculatedAmountThreshold, calculatedAmount, "threshold");
        } else {
            assertGt(c.calculatedAmountThreshold, calculatedAmount, "threshold");
        }
    }

    function testRevert_RefundNativeNonPayable(RefundNativeNonPayableCase memory c) private disableReceive {
        _initializePools(c.poolKeys);

        vm.deal(_PAYER, _EXACT_OUT_APPROVE_AMOUNT);

        vm.expectRevert(IHyperRouter.NativeTransferFailed.selector);
        LibCall.callContract(address(hyperRouter), _EXACT_OUT_APPROVE_AMOUNT, c.data);
    }

    function test_MinimalCalldata(MinimalCalldataCase memory c) private {
        assertEq(c.data.length, _MINIMAL_CALLDATA_LENGTH);

        PoolKey[] memory pks = new PoolKey[](1);
        pks[0] = c.poolKey;
        _initializePools(pks);

        (bool success, bytes memory data) = address(hyperRouter).call(c.data);
        assertTrue(success, "success");

        HyperRouterLib.SwapReturndata memory returndata = HyperRouterLib.decodeSwapReturndata(data);

        assertEq(returndata.calculatedAmount, 0, "calculatedAmount");
        assertEq(returndata.integrationFee, 0, "integrationFee");
    }

    function test_claimIntegrationFeesNative() external {
        _accrueIntegrationFees(NATIVE_TOKEN_ADDRESS);

        address[] memory tokens = new address[](1);
        tokens[0] = NATIVE_TOKEN_ADDRESS;

        uint256 balanceBefore = address(this).balance;
        uint256[] memory res = hyperRouter.claimIntegrationFees(tokens);
        uint256 balanceAfter = address(this).balance;

        assertEq(res.length, 1);
        assertEq(res[0], _INTEGRATION_FEE_AMOUNT);
        assertEq(balanceAfter - balanceBefore, _INTEGRATION_FEE_AMOUNT);
    }

    function test_claimIntegrationFeesERC20() external {
        _accrueIntegrationFees(_ERC_20_FIRST_ADDRESS);

        address[] memory tokens = new address[](1);
        tokens[0] = _ERC_20_FIRST_ADDRESS;

        uint256 balanceBefore = IERC20(_ERC_20_FIRST_ADDRESS).balanceOf(address(this));
        uint256[] memory res = hyperRouter.claimIntegrationFees(tokens);
        uint256 balanceAfter = IERC20(_ERC_20_FIRST_ADDRESS).balanceOf(address(this));

        assertEq(res.length, 1);
        assertEq(res[0], _INTEGRATION_FEE_AMOUNT);
        assertEq(balanceAfter - balanceBefore, _INTEGRATION_FEE_AMOUNT);
    }

    function test_claimIntegrationFeesMultiple() external {
        _accrueIntegrationFees(NATIVE_TOKEN_ADDRESS);
        _accrueIntegrationFees(_ERC_20_FIRST_ADDRESS);

        address[] memory tokens = new address[](2);
        tokens[0] = NATIVE_TOKEN_ADDRESS;
        tokens[1] = _ERC_20_FIRST_ADDRESS;

        (uint256 balanceBeforeNative, uint256 balanceBeforeErc20) =
            (address(this).balance, IERC20(_ERC_20_FIRST_ADDRESS).balanceOf(address(this)));

        uint256[] memory res = hyperRouter.claimIntegrationFees(tokens);

        (uint256 balanceAfterNative, uint256 balanceAfterErc20) =
            (address(this).balance, IERC20(_ERC_20_FIRST_ADDRESS).balanceOf(address(this)));

        assertEq(res.length, 2);
        assertEq(res[0], _INTEGRATION_FEE_AMOUNT);
        assertEq(res[1], _INTEGRATION_FEE_AMOUNT);

        assertEq(balanceAfterNative - balanceBeforeNative, _INTEGRATION_FEE_AMOUNT);
        assertEq(balanceAfterErc20 - balanceBeforeErc20, _INTEGRATION_FEE_AMOUNT);
    }

    function _accrueIntegrationFees(address token) private {
        if (token == NATIVE_TOKEN_ADDRESS) {
            deal(address(CORE), _INTEGRATION_FEE_AMOUNT);
        } else {
            deal(token, address(CORE), _INTEGRATION_FEE_AMOUNT);
        }

        vm.store(
            address(CORE),
            StorageSlot.unwrap(
                CoreStorageLayout.savedBalancesSlot(
                    address(hyperRouter), token, address(type(uint160).max), bytes32(uint256(uint160(address(this))))
                )
            ),
            bytes32(bytes16(_INTEGRATION_FEE_AMOUNT))
        );
    }

    function _initializePools(PoolKey[] memory keys) private {
        for (uint256 i = 0; i < keys.length; i++) {
            PoolKey memory pk = keys[i];

            (bool initialized,) = positions.maybeInitializePool(pk, 0);

            // Don't add a position twice if one pool appears multiple times in the route
            if (initialized) {
                PoolConfig config = pk.config;
                int32 tickLower;
                int32 tickUpper;

                if (config.isConcentrated()) {
                    int32 tickSpacing = int32(config.concentratedTickSpacing());
                    (tickLower, tickUpper) = (-tickSpacing, tickSpacing);
                } else {
                    (tickLower, tickUpper) = config.stableswapActiveLiquidityTickRange();
                }

                _approvePositions(pk.token1);

                positions.mintAndDeposit{value: _approvePositions(pk.token0)}(
                    pk, tickLower, tickUpper, _POSITION_AMOUNT, _POSITION_AMOUNT, 0
                );
            }
        }
    }

    function _balanceOf(address owner, address token) private view returns (uint256 balance) {
        if (token == NATIVE_TOKEN_ADDRESS) {
            return owner.balance;
        } else {
            return IERC20(token).balanceOf(owner);
        }
    }

    function _unclaimedIntegrationFees(address owner, address token) private view returns (uint128 balance) {
        (balance,) = CORE.savedBalances(
            address(hyperRouter), token, address(type(uint160).max), bytes32(uint256(uint160(owner)))
        );
    }

    function _approve(address token, address spender, uint256 amount) private returns (uint256 value) {
        if (token == NATIVE_TOKEN_ADDRESS) {
            deal(address(this), amount);
            value = amount;
        } else {
            deal(token, address(this), amount);
            IERC20(token).approve(spender, amount);

            // Such that the equivalent amount of the underlying token is redeemable
            if (token == _TOKEN_WRAPPER_ADDRESS) {
                deal(
                    _ERC_20_FIRST_ADDRESS,
                    address(CORE),
                    IERC20(_ERC_20_FIRST_ADDRESS).balanceOf(address(CORE)) + amount
                );

                (uint128 balance,) =
                    CORE.savedBalances(_TOKEN_WRAPPER_ADDRESS, _ERC_20_FIRST_ADDRESS, address(type(uint160).max), 0);

                vm.store(
                    address(CORE),
                    StorageSlot.unwrap(
                        CoreStorageLayout.savedBalancesSlot(
                            _TOKEN_WRAPPER_ADDRESS, _ERC_20_FIRST_ADDRESS, address(type(uint160).max), 0
                        )
                    ),
                    bytes32(bytes16(balance + SafeCastLib.toUint128(amount)))
                );
            }
        }
    }

    function _approvePositions(address token) private returns (uint256 value) {
        value = _approve(token, address(positions), _POSITION_AMOUNT);
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
        bytes memory result = LibCall.delegateCallContract(address(hyperRouter), msg.data);
        uint256 len = result.length;

        assembly ("memory-safe") {
            let free := mload(0x40)
            mcopy(free, add(result, 0x20), len)
            return(free, len)
        }
    }
}
