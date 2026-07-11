// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {CreateHuffRouter} from "../src/CreateHuffRouter.sol";
import {HuffRouterLib, IHuffRouter} from "../src/HuffRouter.sol";
import {FixedSavedBalanceIntegrator} from "../src/Integrator.sol";
import {CORE_ADDRESS, MEV_CAPTURE_ADDRESS, ORACLE_ADDRESS, TWAMM_ADDRESS} from "../src/addresses.sol";

import {Positions} from "ekubo/Positions.sol";
import {ICore} from "ekubo/interfaces/ICore.sol";
import {IFlashAccountant} from "ekubo/interfaces/IFlashAccountant.sol";
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

contract BaseTest is Test {
    ICore internal constant CORE = ICore(CORE_ADDRESS);
    // cast keccak "HuffRouterTest#DISABLE_RECEIVE_SLOT"
    uint256 internal constant _DISABLE_RECEIVE_SLOT =
        0x27095381dc94d25f5c191482faa73780fd308183456a62f43e8833e46ea4a541;

    // TODO Also sync with SDK
    address internal constant _ERC_20_FIRST_ADDRESS = 0x1111111111111111111111111111111111111111;
    address internal constant _ERC_20_SECOND_ADDRESS = 0x2222222222222222222222222222222222222222;
    address internal constant _TOKEN_WRAPPER_ADDRESS = 0x3333333333333333333333333333333333333333;

    CreateHuffRouter internal factory;
    IPositions internal positions;

    function deploy() internal {
        factory = HuffRouterLib.deployFactory(false);

        deployCodeTo("v3-artifacts/Core.json", CORE_ADDRESS);
        deployCodeTo("v3-artifacts/MEVCapture.json", abi.encode(CORE_ADDRESS), MEV_CAPTURE_ADDRESS);
        deployCodeTo("v3-artifacts/Oracle.json", abi.encode(CORE_ADDRESS), ORACLE_ADDRESS);
        deployCodeTo("v3-artifacts/TWAMM.json", abi.encode(CORE_ADDRESS), TWAMM_ADDRESS);

        positions = new Positions(CORE, address(this), 0, 1);

        deployCodeTo("HuffRouter.t.sol:TestToken", _ERC_20_FIRST_ADDRESS);
        deployCodeTo("HuffRouter.t.sol:TestToken", _ERC_20_SECOND_ADDRESS);

        deployCodeTo(
            "v3-artifacts/TokenWrapper.json",
            abi.encode(CORE, _ERC_20_FIRST_ADDRESS, block.timestamp),
            _TOKEN_WRAPPER_ADDRESS
        );
    }

    function deployDefaultRouter() internal returns (IHuffRouter router) {
        CreateHuffRouter.InitializationParams memory params;
        params.expirationTimestamp = type(uint256).max;

        router = factory.create(params);
    }
}

contract HuffRouterTest is BaseTest {
    uint128 private constant _INTEGRATION_FEE_AMOUNT = 1 ether;
    uint256 private constant _MAX_CODE_SIZE = 24_576; // https://eips.ethereum.org/EIPS/eip-170

    function setUp() public {
        deploy();
    }

    // TODO Change to make sure that runtime bytecode doesn't exceed limit (move to CreateHuffRouterTest)
    function test_ContractSize() external {
        uint256 codeSize = HuffRouterLib.initcodeSize();
        console.log(codeSize);

        assertLe(codeSize, _MAX_CODE_SIZE);
    }

    // TODO Test that we can retrieve the same params with extcodecopy
    /*function test_Immutables() external {
        CreateHuffRouter.InitializationParams memory params = CreateHuffRouter.InitializationParams({

        })
    }*/

    function testRevert_Expired() external {
        uint256 expirationTimestamp = 100;

        CreateHuffRouter.InitializationParams memory params;
        params.expirationTimestamp = expirationTimestamp;
        IHuffRouter router = factory.create(params);

        {
            vm.expectRevert(IHuffRouter.CoreOnly.selector);
            (bool reverts,) = address(router).call("");
            assertTrue(reverts, "before expiry");
        }

        vm.warp(expirationTimestamp);

        {
            vm.expectRevert(abi.encodeWithSelector(IHuffRouter.Expired.selector, expirationTimestamp));
            (bool reverts,) = address(router).call("");
            assertTrue(reverts, "after expiry");
        }
    }

    function testRevert_LockedCoreOnly() external {
        IHuffRouter router = deployDefaultRouter();

        vm.expectRevert(IHuffRouter.CoreOnly.selector);
        router.locked_6416899205(0);
    }

    function testRevert_ShortCalldataZeroesLockSelector() external {
        // `0x00` keeps us on the lock-swap path with `withRecipient == false`.
        // The nonzero second byte avoids the `locked` branch, while `calldatasize == 2`
        // makes the synthetic recipient write start at offset 0 and zero out the selector.
        (bool success, bytes memory result) = address(deployDefaultRouter()).call(hex"0001");

        assertFalse(success, "success");
        assertEq(bytes4(result), ICore.InvalidSqrtRatioLimit.selector, "error selector");
    }

    // `0x01` is parsed as `withRecipient == true`, so the router still calls `Core.lock()`.
    // In the locked callback, the appended ABI-encoded caller address is read as route data,
    // which collapses into a no-op path that returns zeroed swap returndata.
    function test_OneByteCalldata() external {
        (bool success, bytes memory data) = address(deployDefaultRouter()).call(hex"01");

        assertTrue(success, "success");

        HuffRouterLib.SwapReturndata memory returndata = HuffRouterLib.decodeSwapReturndata(data);

        assertEq(returndata.calculatedAmount, 0, "calculatedAmount");
        assertEq(returndata.integrationFee, 0, "integrationFee");
    }

    function testRevert_ZeroLengthCalldata() external {
        // Dispatched to the locked path and reverts because not called by Core
        (bool success, bytes memory result) = address(deployDefaultRouter()).call(hex"");

        assertFalse(success, "success");
        assertEq(bytes4(result), IHuffRouter.CoreOnly.selector, "error selector");
    }

    // `0x00..01` stays on the lock-swap path with `withRecipient == false`.
    // Lengths 3..5 partially clobber `lock()` into unknown selectors on Core.
    // Lengths 6..9 keep `lock()`, but the trailing `0x01` lands in progressively later
    // route-control fields and the locked callback eventually fails with empty returndata.
    function testRevert_ThreeToNineByteCalldata() external {
        bytes[] memory cases = new bytes[](7);
        cases[0] = hex"000001"; // len 3: selector becomes `0xf8000000`
        cases[1] = hex"00000001"; // len 4: selector becomes `0xf83d0000`
        cases[2] = hex"0000000001"; // len 5: selector becomes `0xf83d0800`
        cases[3] = hex"000000000001"; // len 6: parsed `additionalMultiHops = 1`
        cases[4] = hex"00000000000001"; // len 7: parsed `withIntegrationFee = 1`
        cases[5] = hex"0000000000000001"; // len 8: parsed flags byte = `0x01`
        cases[6] = hex"000000000000000001"; // len 9: first threshold data byte = `0x01`

        address router = address(deployDefaultRouter());

        for (uint256 i = 0; i < cases.length; i++) {
            (bool success, bytes memory result) = router.call(cases[i]);

            assertFalse(success, "success");
            assertEq(result, "", "returndata");
        }
    }

    function testRevert_TrailingCalldataCannotOverrideTransferFrom() external {
        address router = address(deployDefaultRouter());

        uint32 specifiedAmount = 20_000_000;
        address attacker = address(this);
        address victim = makeAddr("victim");

        deal(_ERC_20_FIRST_ADDRESS, address(CORE), specifiedAmount);
        deal(_ERC_20_FIRST_ADDRESS, victim, specifiedAmount);

        vm.prank(victim);
        IERC20(_ERC_20_FIRST_ADDRESS).approve(router, specifiedAmount);

        bytes memory data = abi.encodePacked(
            hex"000400ffff000000",
            bytes20(_ERC_20_FIRST_ADDRESS),
            bytes20(_ERC_20_FIRST_ADDRESS),
            bytes4(specifiedAmount),
            hex"000501",
            bytes20(attacker),
            bytes12(0),
            bytes20(victim)
        );

        // TODO Assert with vm.expectCall that transferFrom is being made from attacker
        (bool success,) = router.call(data);

        assertFalse(success, "success");
    }

    function test_TrailingCalldataCannotDrainVictimWhenAttackerAllowanceIsActive() external {
        address router = address(deployDefaultRouter());

        uint32 specifiedAmount = 20_000_000;
        address attacker = address(this);
        address victim = makeAddr("victim");

        deal(_ERC_20_FIRST_ADDRESS, address(CORE), specifiedAmount);
        deal(_ERC_20_FIRST_ADDRESS, victim, specifiedAmount);

        IERC20(_ERC_20_FIRST_ADDRESS).approve(router, specifiedAmount);

        vm.prank(victim);
        IERC20(_ERC_20_FIRST_ADDRESS).approve(router, specifiedAmount);

        bytes memory data = abi.encodePacked(
            hex"000400ffff000000",
            bytes20(_ERC_20_FIRST_ADDRESS),
            bytes20(_ERC_20_FIRST_ADDRESS),
            bytes4(specifiedAmount),
            hex"000501",
            bytes20(attacker),
            bytes12(0),
            bytes20(victim)
        );

        uint256 attackerBalanceBefore = IERC20(_ERC_20_FIRST_ADDRESS).balanceOf(attacker);
        uint256 victimBalanceBefore = IERC20(_ERC_20_FIRST_ADDRESS).balanceOf(victim);

        (bool success, bytes memory returndataRaw) = router.call(data);

        assertTrue(success, "success");

        HuffRouterLib.SwapReturndata memory returndata = HuffRouterLib.decodeSwapReturndata(returndataRaw);

        assertEq(returndata.calculatedAmount, specifiedAmount, "calculatedAmount");
        assertEq(returndata.integrationFee, 0, "integrationFee");
        assertEq(
            IERC20(_ERC_20_FIRST_ADDRESS).balanceOf(attacker), attackerBalanceBefore, "unexpected attacker balance"
        );
        assertEq(IERC20(_ERC_20_FIRST_ADDRESS).balanceOf(victim), victimBalanceBefore, "unexpected victim balance");
    }

    /*function test_claimIntegrationFeesNative() external {
        _accrueIntegrationFees(NATIVE_TOKEN_ADDRESS);

        address[] memory tokens = new address[](1);
        tokens[0] = NATIVE_TOKEN_ADDRESS;

        uint256 balanceBefore = address(this).balance;
        uint256[] memory res = deployDefaultRouter().claimIntegrationFees(tokens);
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
        uint256[] memory res = deployDefaultRouter().claimIntegrationFees(tokens);
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

        uint256[] memory res = huffRouter.claimIntegrationFees(tokens);

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
                    address(huffRouter), token, address(type(uint160).max), bytes32(uint256(uint160(address(this))))
                )
            ),
            bytes32(bytes16(_INTEGRATION_FEE_AMOUNT))
        );
    }*/

    receive() external payable {
        bool reject;
        assembly ("memory-safe") {
            reject := tload(_DISABLE_RECEIVE_SLOT)
        }

        if (reject) {
            revert();
        }
    }
}

contract SdkTest is BaseTest {
    using CoreLib for *;

    uint128 private constant _POSITION_AMOUNT = 100_000 ether;
    uint256 private constant _EXACT_OUT_APPROVE_AMOUNT = 10 ether;

    address private immutable _PAYER = address(this);
    uint256 private constant _MINIMAL_CALLDATA_LENGTH = 9;

    FixedSavedBalanceIntegrator private integrator;

    address private routerWithIntegrator;
    address private routerWithoutIntegrator;

    struct SdkCases {
        SuccessCase[] success;
        RefundNativeNonPayableCase refundNativeNonPayable;
        SlippageCheckFailedCase[] slippageCheckFailed;
        MinimalCalldataCase minimalCalldata;
    }

    struct SuccessCase {
        bytes data;
        PoolKey[] poolKeys;

        address specifiedToken;
        address calculatedToken;
        uint256 totalSpecified;

        bool isExactOut;

        address recipient;
        bool withIntegrationFee;

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

    function test_SdkCases() external {
        deploy();

        integrator = new FixedSavedBalanceIntegrator(CORE, address(this), type(uint128).max);

        CreateHuffRouter.InitializationParams memory params = CreateHuffRouter.InitializationParams({
            expirationTimestamp: type(uint256).max,
            integrator: address(integrator),
            tokens: HuffRouterLib.getTokenList(vm)
        });
        routerWithIntegrator = address(factory.create(params));

        params.integrator = address(0);

        routerWithoutIntegrator = address(factory.create(params));

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
    function executeSdkCases(SdkCases memory cases) public {
        uint256 snapshotId = vm.snapshotState();

        for (uint256 i = 0; i < cases.success.length; i++) {
            test_Success(cases.success[i]);
            vm.revertToState(snapshotId);
        }

        for (uint256 i = 0; i < cases.slippageCheckFailed.length; i++) {
            testRevert_SlippageCheckFailed(cases.slippageCheckFailed[i]);
            vm.revertToState(snapshotId);
        }

        testRevert_RefundNativeNonPayable(cases.refundNativeNonPayable);
        vm.revertToState(snapshotId);

        test_MinimalCalldata(cases.minimalCalldata);
    }

    function test_Success(SuccessCase memory c) private {
        _initializePools(c.poolKeys);

        address router = c.withIntegrationFee ? routerWithIntegrator : routerWithoutIntegrator;

        (address tokenIn, address tokenOut, address integratorToken) = c.isExactOut
            ? (c.calculatedToken, c.specifiedToken, c.specifiedToken)
            : (c.specifiedToken, c.calculatedToken, c.calculatedToken);

        // Multiply the total specified amount because the testdata contains some unprofitable arbitrage swaps
        uint256 dealAmount = c.isExactOut ? _EXACT_OUT_APPROVE_AMOUNT : c.totalSpecified * 10;
        uint256 value = _approve(tokenIn, router, dealAmount);

        address recipient = c.recipient == address(0) ? _PAYER : c.recipient;

        (uint256 payerBalanceBefore, uint256 recipientBalanceBefore, uint128 integratorBalanceBefore) = (
            _balanceOf(_PAYER, tokenIn),
            _balanceOf(recipient, tokenOut),
            c.withIntegrationFee ? integrator.savedBalance(integratorToken) : 0
        );

        bytes memory result = LibCall.callContract(router, value, c.data);
        vm.snapshotGasLastCall(c.name);

        HuffRouterLib.SwapReturndata memory returndata = HuffRouterLib.decodeSwapReturndata(result);

        assertNotEq(returndata.calculatedAmount, 0);

        if (c.withIntegrationFee) {
            assertNotEq(returndata.integrationFee, 0);
        }

        (uint256 payerBalanceAfter, uint256 recipientBalanceAfter, uint128 integratorBalanceAfter) = (
            _balanceOf(_PAYER, tokenIn),
            _balanceOf(recipient, tokenOut),
            c.withIntegrationFee ? integrator.savedBalance(integratorToken) : 0
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

        (bool success, bytes memory result) = address(routerWithoutIntegrator).call(c.data);
        assertFalse(success, "success");

        // forge-lint: disable-next-line(unsafe-typecast)
        assertEq(IHuffRouter.SlippageCheckFailed.selector, bytes4(result), "error selector");

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

        vm.expectRevert(IHuffRouter.NativeTransferFailed.selector);
        LibCall.callContract(routerWithoutIntegrator, _EXACT_OUT_APPROVE_AMOUNT, c.data);
    }

    function test_MinimalCalldata(MinimalCalldataCase memory c) private {
        assertEq(c.data.length, _MINIMAL_CALLDATA_LENGTH);

        PoolKey[] memory pks = new PoolKey[](1);
        pks[0] = c.poolKey;
        _initializePools(pks);

        (bool success, bytes memory data) = routerWithoutIntegrator.call(c.data);
        assertTrue(success, "success");

        HuffRouterLib.SwapReturndata memory returndata = HuffRouterLib.decodeSwapReturndata(data);

        assertEq(returndata.calculatedAmount, 0, "calculatedAmount");
        assertEq(returndata.integrationFee, 0, "integrationFee");
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

    function _balanceOf(address owner, address token) private view returns (uint256 balance) {
        if (token == NATIVE_TOKEN_ADDRESS) {
            return owner.balance;
        } else {
            return IERC20(token).balanceOf(owner);
        }
    }
}

// By deploying without appending additional immutable arguments we can assert the value of the
// immutables offset via an equality comparison with the runtime code length
contract ImmutableOffsetTest is Test {
    function test_ImmutablesOffset() external {
        IHuffRouter router = HuffRouterLib.deployIsolated();
        assertEq(address(router).code.length, HuffRouterLib.IMMUTABLES_OFFSET);
    }

    function _transientInitializationParams() external pure {}
}
