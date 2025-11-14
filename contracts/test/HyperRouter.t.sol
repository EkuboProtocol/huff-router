// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {HyperRouterLib, IHyperRouter} from "../src/HyperRouter.sol";
import {CORE_ADDRESS, MEV_CAPTURE_ADDRESS, ORACLE_ADDRESS, TWAMM_ADDRESS} from "../src/addresses.sol";

import {findExtensionSalt} from "ekubo-script/DeployCore.s.sol";
import {Core} from "ekubo/Core.sol";
import {Positions} from "ekubo/Positions.sol";
import {TokenWrapper} from "ekubo/TokenWrapper.sol";
import {MEVCapture, mevCaptureCallPoints} from "ekubo/extensions/MEVCapture.sol";
import {Oracle, oracleCallPoints} from "ekubo/extensions/Oracle.sol";
import {TWAMM, twammCallPoints} from "ekubo/extensions/TWAMM.sol";
import {ICore} from "ekubo/interfaces/ICore.sol";
import {IPositions} from "ekubo/interfaces/IPositions.sol";
import {CoreLib} from "ekubo/libraries/CoreLib.sol";
import {CoreStorageLayout} from "ekubo/libraries/CoreStorageLayout.sol";
import {NATIVE_TOKEN_ADDRESS} from "ekubo/math/constants.sol";
import {CallPoints} from "ekubo/types/callPoints.sol";
import {PoolConfig, createFullRangePoolConfig} from "ekubo/types/poolConfig.sol";
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

    struct SdkCases {
        SuccessCase[] success;
        RefundNativeNonPayableCase refundNativeNonPayable;
        SlippageCheckFailedCase[] slippageCheckFailed;
    }

    uint256 private constant _EXACT_OUT_APPROVE_AMOUNT = 10 ether;
    uint128 private constant _POSITION_AMOUNT = 100_000 ether;
    address private immutable _PAYER = address(this);

    // cast keccak "HyperRouterTest#DISABLE_RECEIVE_SLOT"
    uint256 private constant _DISABLE_RECEIVE_SLOT = 0x27095381dc94d25f5c191482faa73780fd308183456a62f43e8833e46ea4a541;
    uint256 private constant _MAX_CODE_SIZE = 24_576; // https://eips.ethereum.org/EIPS/eip-170

    IHyperRouter private hyperRouter;
    ICore private core;
    IPositions private positions;

    address private oracle;
    address private twamm;
    address private mevCapture;

    // TODO Also sync with SDK
    address private constant _ERC_20_FIRST_ADDRESS = 0x1111111111111111111111111111111111111111;
    address private constant _ERC_20_SECOND_ADDRESS = 0x2222222222222222222222222222222222222222;
    address private constant _TOKEN_WRAPPER_ADDRESS = 0x3333333333333333333333333333333333333333;

    bytes32 private constant _CREATE2_SALT = 0;

    function setUp() public {
        hyperRouter = HyperRouterLib.deploy(vm);

        core = new Core{salt: _CREATE2_SALT}();
        positions = new Positions(core, address(this), 0, 1);

        oracle = address(new Oracle{salt: _findExtensionSalt(type(Oracle).creationCode, oracleCallPoints())}(core));
        twamm = address(new TWAMM{salt: _findExtensionSalt(type(TWAMM).creationCode, twammCallPoints())}(core));
        mevCapture = address(
            new MEVCapture{salt: _findExtensionSalt(type(MEVCapture).creationCode, mevCaptureCallPoints())}(core)
        );

        bytes memory tokenCode = address(new TestToken()).code;
        vm.etch(_ERC_20_FIRST_ADDRESS, tokenCode);
        vm.etch(_ERC_20_SECOND_ADDRESS, tokenCode);

        vm.etch(
            _TOKEN_WRAPPER_ADDRESS, address(new TokenWrapper(core, IERC20(_ERC_20_FIRST_ADDRESS), block.timestamp)).code
        );
    }

    function test_DeploymentAddresses() external view {
        assertEq(address(core), CORE_ADDRESS, "Core");
        assertEq(oracle, ORACLE_ADDRESS, "Oracle");
        assertEq(twamm, TWAMM_ADDRESS, "TWAMM");
        assertEq(mevCapture, MEV_CAPTURE_ADDRESS, "MEVCapture");
    }

    function _findExtensionSalt(bytes memory creationCode, CallPoints memory callPoints)
        private
        view
        returns (bytes32 salt)
    {
        bytes32 initCodeHash = keccak256(abi.encodePacked(creationCode, abi.encode(core)));
        salt = findExtensionSalt(_CREATE2_SALT, initCodeHash, callPoints);
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

    function test_ContractSize() external view {
        address hyperRouterAddr = address(hyperRouter);
        uint256 codeSize;
        assembly ("memory-safe") {
            codeSize := extcodesize(hyperRouterAddr)
        }

        console.log(codeSize);

        assertLe(codeSize, _MAX_CODE_SIZE);
    }

    // TODO Make SDK case
    function test_MinimalCalldata() external {
        core.initializePool(
            PoolKey({
                token0: NATIVE_TOKEN_ADDRESS,
                token1: _ERC_20_FIRST_ADDRESS,
                config: createFullRangePoolConfig({_fee: 0, _extension: ORACLE_ADDRESS})
            }),
            0
        );

        (bool success, bytes memory data) = address(hyperRouter)
            .call(
                hex"00" // withRecipient
                hex"00" // specifiedAmountBytes
                hex"00" // calculatedAmountThresholdBytes
                hex"00" // specifiedTokenInfo
                hex"01" // calculatedTokenInfo
                hex"00" // additionalMultiHops
                hex"00" // withIntegrationFee
                hex"00" // withSqrtRatioLimit | isExactOut
                hex"00" // additionalHops
                hex"01" // hopType
            );
        assertTrue(success, "success");

        HyperRouterLib.SwapReturndata memory returndata = HyperRouterLib.decodeSwapReturndata(data);

        assertEq(returndata.calculatedAmount, 0, "calculatedAmount");
        assertEq(returndata.integrationFee, 0, "integrationFee");
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
    }

    function test_Success(SuccessCase memory t) public {
        _initializePools(t.poolKeys);

        (address tokenIn, address tokenOut, address integratorToken) = t.isExactOut
            ? (t.calculatedToken, t.specifiedToken, t.specifiedToken)
            : (t.specifiedToken, t.calculatedToken, t.calculatedToken);

        // Double the total specified amount because the testdata contains some unprofitable arbitrage swaps
        uint256 dealAmount = t.isExactOut ? _EXACT_OUT_APPROVE_AMOUNT : t.totalSpecified * 10;
        uint256 value = _approve(tokenIn, address(hyperRouter), dealAmount);

        address recipient = t.recipient == address(0) ? _PAYER : t.recipient;

        (uint256 payerBalanceBefore, uint256 recipientBalanceBefore, uint128 integratorBalanceBefore) = (
            _balanceOf(_PAYER, tokenIn),
            _balanceOf(recipient, tokenOut),
            _unclaimedIntegrationFees(t.integrator, integratorToken)
        );

        bytes memory result = LibCall.callContract(address(hyperRouter), value, t.data);
        vm.snapshotGasLastCall(t.name);

        HyperRouterLib.SwapReturndata memory returndata = HyperRouterLib.decodeSwapReturndata(result);

        assertNotEq(returndata.calculatedAmount, 0);

        if (t.integrator != address(0)) {
            assertNotEq(returndata.integrationFee, 0);
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
            : (
                // Extra input won't be refunded if we're doing an exact-in swap
                -SafeCastLib.toInt256(tokenIn == NATIVE_TOKEN_ADDRESS ? dealAmount : t.totalSpecified),
                SafeCastLib.toInt256(returndata.calculatedAmount)
            );

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
        (balance,) = core.savedBalances(
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
                    address(core),
                    IERC20(_ERC_20_FIRST_ADDRESS).balanceOf(address(core)) + amount
                );

                (uint128 balance,) =
                    core.savedBalances(_TOKEN_WRAPPER_ADDRESS, _ERC_20_FIRST_ADDRESS, address(type(uint160).max), 0);

                vm.store(
                    address(core),
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
