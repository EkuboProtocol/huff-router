// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {HyperRouter, CORE_ADDRESS, ORACLE_ADDRESS, TWAMM_ADDRESS, MEV_RESIST_ADDRESS} from "../src/HyperRouter.sol";
import {TestCase, MultiHopSwap, Swap, IntegrationFee, PoolConfig, BasePoolConfig} from "./TestCase.sol";
import {LibBit} from "solady/utils/LibBit.sol";
import {MIN_SQRT_RATIO_RAW, MAX_SQRT_RATIO_RAW} from "ekubo/src/types/sqrtRatio.sol";
import {LibBytes} from "solady/utils/LibBytes.sol";
import {ICore} from "ekubo/interfaces/ICore.sol";
import {CoreLib} from "ekubo/libraries/CoreLib.sol";
import {readTokensFromFile} from "../src/TokenReader.sol";
import {SafeCastLib} from "solady/utils/SafeCastLib.sol";
import {TokenInfo, resolve} from "./TokenInfo.sol";
import {NATIVE_TOKEN_ADDRESS} from "ekubo/src/math/constants.sol";
import {LibCall} from "solady/utils/LibCall.sol";

contract HyperRouterTest is Test {
    using {resolve} for address[];
    using CoreLib for ICore;

    struct TokenAmount {
        address token;
        uint128 amount;
    }

    struct Route {
        address specifiedToken;
        uint128 amount;
        MultiHopSwap[] multiHopSwaps;
        uint128 expectedCalculatedExactIn;
        uint128 expectedCalculatedExactOut;
    }

    address constant USDC_ADDRESS = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant USDT_ADDRESS = 0xdAC17F958D2ee523a2206206994597C13D831ec7;

    bytes32 constant SAVED_BALANCE_SALT = keccak256("HYPER_ROUTER");

    uint256 constant EXACT_OUT_DEAL_AMOUNT = type(uint128).max / 2;

    ICore constant CORE = ICore(CORE_ADDRESS);

    bool[2] bools = [true, false];
    address[2] recipients = [address(0), 0x00000C771F6176268D5A9846E0956C3eF58597A1];

    PoolConfig oracleConfig = PoolConfig({extension: ORACLE_ADDRESS, fee: 0, tickSpacing: 0});

    BasePoolConfig ethUsdc2Bips = BasePoolConfig({fee: 3689348814741910, tickSpacing: 4990});
    BasePoolConfig ethUsdc5Bips = BasePoolConfig({fee: 9223372036854775, tickSpacing: 1000});

    BasePoolConfig usdcUsdt = BasePoolConfig({fee: 92233720368547, tickSpacing: 50});

    BasePoolConfig usdtEth2Bips = BasePoolConfig({fee: 3689348814741910, tickSpacing: 4990});
    BasePoolConfig usdtEth09Bips = BasePoolConfig({fee: 1660206966633859, tickSpacing: 4990});
    BasePoolConfig usdtEth3Bips = BasePoolConfig({fee: 5534023222112865, tickSpacing: 4990});

    // Three different base pool swap sequences of length three between tokens with ID 0 to 2 (ETH, USDC, USDT, as per tokens.json)
    BasePoolConfig[3][3] swapSequences = [
        [ethUsdc2Bips, usdcUsdt, usdtEth2Bips],
        [ethUsdc5Bips, usdcUsdt, usdtEth09Bips],
        [ethUsdc2Bips, usdcUsdt, usdtEth3Bips]
    ];

    PoolConfig[4] ethUsdcExtensionConfigs = [
        ethUsdc2Bips.toPoolConfig(),
        oracleConfig,
        PoolConfig({extension: TWAMM_ADDRESS, fee: 9223372036854775, tickSpacing: 0}),
        PoolConfig({extension: MEV_RESIST_ADDRESS, fee: 1844674407370954, tickSpacing: 1000})
    ];

    address hyperRouter;
    address[] tokens = readTokensFromFile(vm);

    TestCase baseCase;

    constructor() {
        MultiHopSwap[] memory multiHopSwaps = new MultiHopSwap[](2);

        {
            Swap[] memory firstSwaps = new Swap[](1);

            firstSwaps[0] = Swap({
                config: ethUsdc2Bips.toPoolConfig(),
                isKnownExtension: true,
                skipAhead: 2,
                calculatedTokenInfo: TokenInfo({value: address(1), isKnown: true}),
                sqrtRatioLimit: 0
            });

            multiHopSwaps[0] = MultiHopSwap({specifiedAmount: 1 ether, swaps: firstSwaps});
        }

        {
            Swap[] memory secondSwaps = new Swap[](2);

            secondSwaps[0] = Swap({
                config: usdtEth2Bips.toPoolConfig(),
                isKnownExtension: false,
                skipAhead: 1,
                calculatedTokenInfo: TokenInfo({value: address(2), isKnown: true}),
                sqrtRatioLimit: 0
            });

            secondSwaps[1] = Swap({
                config: usdcUsdt.toPoolConfig(),
                isKnownExtension: true,
                skipAhead: 0,
                calculatedTokenInfo: TokenInfo({value: USDC_ADDRESS, isKnown: false}),
                sqrtRatioLimit: 0
            });

            multiHopSwaps[1] = MultiHopSwap({specifiedAmount: 1 ether / 2, swaps: secondSwaps});
        }

        baseCase = TestCase({
            specifiedTokenInfo: TokenInfo({value: address(0), isKnown: true}),
            calculatedTokenInfo: TokenInfo({value: address(1), isKnown: true}),
            isExactOut: false,
            withSqrtRatioLimit: false,
            multiHopSwaps: multiHopSwaps,
            delegateCall: false,
            recipient: address(0),
            calculatedAmountThreshold: 0,
            integrationFee: IntegrationFee({share: 0, integrator: address(0)})
        });
    }

    modifier setUpFork(uint256 blockNumber) {
        vm.createSelectFork(vm.rpcUrl("mainnet"), blockNumber);

        address addr = HyperRouter.deploy(vm);
        hyperRouter = addr;

        uint256 routerCodesize;
        assembly {
            routerCodesize := extcodesize(addr)
        }

        _;
    }

    function minRequiredBytes(uint128 val) private pure returns (uint8 byteCount) {
        uint256 fls = LibBit.fls(val);

        if (fls == 256) {
            byteCount = 0;
        } else {
            byteCount = uint8((fls / 8) + 1);
        }
    }

    function varLengthEncoded(uint128 val, uint8 b) private pure returns (bytes memory) {
        return LibBytes.slice(bytes.concat(bytes16(val)), 16 - b);
    }

    function balanceOf(address owner, address token) private view returns (uint256 balance) {
        if (token == NATIVE_TOKEN_ADDRESS) {
            return owner.balance;
        } else {
            return IERC20(token).balanceOf(owner);
        }
    }

    function savedBalance(address owner, address token) private view returns (uint128 balance) {
        return CORE.savedBalances(owner, token, SAVED_BALANCE_SALT);
    }

    function fixtureTestCase() external view returns (TestCase[] memory cases) {
        uint256 specialCaseCount = 2;
        uint256 extensionVariants = ethUsdcExtensionConfigs.length + 1;

        cases = new TestCase[](recipients.length * (bools.length ** 3) * extensionVariants + specialCaseCount);

        {
            TestCase memory specifiedUnknownCase = baseCase;
            specifiedUnknownCase.specifiedTokenInfo = TokenInfo({value: NATIVE_TOKEN_ADDRESS, isKnown: false});

            cases[0] = specifiedUnknownCase;
        }

        {
            TestCase memory calculatedUnknownCase = baseCase;
            calculatedUnknownCase.calculatedTokenInfo = TokenInfo({value: USDC_ADDRESS, isKnown: false});

            cases[1] = calculatedUnknownCase;
        }

        for (uint256 a = 0; a < recipients.length; a++) {
            address recipient = recipients[a];

            for (uint256 b = 0; b < bools.length; b++) {
                bool delegatecall = bools[b];

                for (uint256 c = 0; c < bools.length; c++) {
                    bool withSqrtRatioLimit = bools[c];

                    for (uint256 d = 0; d < bools.length; d++) {
                        bool isExactOut = bools[d];

                        for (uint256 e = 0; e <= ethUsdcExtensionConfigs.length; e++) {
                            TestCase memory testCase = baseCase;

                            testCase.recipient = recipient;
                            testCase.delegateCall = delegatecall;
                            testCase.withSqrtRatioLimit = withSqrtRatioLimit;
                            testCase.isExactOut = isExactOut;

                            if (withSqrtRatioLimit) {
                                for (uint256 i = 0; i < testCase.multiHopSwaps.length; i++) {
                                    MultiHopSwap memory multiHopSwap = testCase.multiHopSwaps[i];
                                    address specifiedToken = resolve(tokens, testCase.specifiedTokenInfo);

                                    for (uint256 j = 0; j < multiHopSwap.swaps.length; j++) {
                                        Swap memory swap = multiHopSwap.swaps[j];

                                        address calculatedToken = resolve(tokens, swap.calculatedTokenInfo);

                                        bool isToken1 = specifiedToken > calculatedToken;
                                        bool isPriceIncreasing = isExactOut != isToken1;

                                        swap.sqrtRatioLimit =
                                            isPriceIncreasing ? MAX_SQRT_RATIO_RAW : MIN_SQRT_RATIO_RAW;

                                        specifiedToken = calculatedToken;
                                    }
                                }
                            }

                            Swap memory firstSwap = testCase.multiHopSwaps[0].swaps[0];

                            if (e == ethUsdcExtensionConfigs.length) {
                                firstSwap.config = ethUsdcExtensionConfigs[0];
                                firstSwap.isKnownExtension = false;
                            } else {
                                firstSwap.config = ethUsdcExtensionConfigs[e];
                            }

                            cases[a * (bools.length ** 3 * extensionVariants)
                                + b * (bools.length ** 2 * extensionVariants) + c * (bools.length * extensionVariants)
                                + d * extensionVariants + e + specialCaseCount] = testCase;
                        }
                    }
                }
            }
        }
    }

    function tableTestCaseTest(TestCase memory testCase) public setUpFork(22968156) {
        bytes memory data = new bytes(8);
        address recipient;

        if (testCase.recipient == address(0)) {
            data[0] = hex"00";
            recipient = address(this);
        } else {
            data[0] = hex"01";
            recipient = testCase.recipient;
        }

        uint8 specifiedAmountBytes;

        for (uint256 i = 0; i < testCase.multiHopSwaps.length; i++) {
            MultiHopSwap memory multiHopSwap = testCase.multiHopSwaps[i];

            uint128 specifiedAmount = multiHopSwap.specifiedAmount;
            uint8 byteCount = minRequiredBytes(specifiedAmount);

            if (byteCount > specifiedAmountBytes) {
                specifiedAmountBytes = byteCount;
            }
        }

        data[1] = bytes1(specifiedAmountBytes);

        uint8 calculatedAmountThresholdBytes = minRequiredBytes(testCase.calculatedAmountThreshold);
        data[2] = bytes1(calculatedAmountThresholdBytes);

        data[3] = testCase.specifiedTokenInfo.id();
        data[4] = testCase.calculatedTokenInfo.id();

        uint256 additionalMultiHopSwaps = testCase.multiHopSwaps.length - 1;

        assertLt(additionalMultiHopSwaps, type(uint8).max);

        data[5] = bytes1(uint8(additionalMultiHopSwaps));
        data[6] = bytes1(testCase.integrationFee.nonZeroShare() ? 1 : 0);
        data[7] = bytes1((testCase.isExactOut ? 1 : 0) + (testCase.withSqrtRatioLimit ? 2 : 0));

        data = bytes.concat(data, varLengthEncoded(testCase.calculatedAmountThreshold, calculatedAmountThresholdBytes));

        if (!testCase.specifiedTokenInfo.isKnown) {
            data = bytes.concat(data, bytes20(testCase.specifiedTokenInfo.value));
        }

        if (!testCase.calculatedTokenInfo.isKnown) {
            data = bytes.concat(data, bytes20(testCase.calculatedTokenInfo.value));
        }

        (address specifiedToken, address calculatedToken) =
            (tokens.resolve(testCase.specifiedTokenInfo), tokens.resolve(testCase.calculatedTokenInfo));

        uint256 totalSpecified;

        for (uint256 i = 0; i < testCase.multiHopSwaps.length; i++) {
            MultiHopSwap memory multiHopSwap = testCase.multiHopSwaps[i];
            uint256 swapCount = multiHopSwap.swaps.length;
            uint256 additionalSwaps = swapCount - 1;

            assertLt(additionalSwaps, type(uint8).max);

            totalSpecified += multiHopSwap.specifiedAmount;

            data = bytes.concat(
                data,
                varLengthEncoded(multiHopSwap.specifiedAmount, specifiedAmountBytes),
                bytes1(uint8(additionalSwaps))
            );

            for (uint256 j = 0; j < swapCount; j++) {
                Swap memory swap = multiHopSwap.swaps[j];

                if (!swap.isKnownExtension) {
                    data = bytes.concat(
                        data,
                        hex"04",
                        bytes1(swap.skipAhead),
                        bytes20(swap.config.extension),
                        bytes8(swap.config.fee),
                        bytes4(swap.config.tickSpacing)
                    );
                } else if (swap.config.extension == address(0)) {
                    data = bytes.concat(
                        data, hex"00", bytes1(swap.skipAhead), bytes8(swap.config.fee), bytes4(swap.config.tickSpacing)
                    );
                } else if (swap.config.extension == ORACLE_ADDRESS) {
                    data = bytes.concat(data, hex"01");
                } else if (swap.config.extension == TWAMM_ADDRESS) {
                    data = bytes.concat(data, hex"02", bytes8(swap.config.fee));
                } else if (swap.config.extension == MEV_RESIST_ADDRESS) {
                    data = bytes.concat(
                        data, hex"03", bytes1(swap.skipAhead), bytes8(swap.config.fee), bytes4(swap.config.tickSpacing)
                    );
                } else {
                    revert();
                }

                if (j == swapCount - 1) {
                    assertEq(calculatedToken, tokens.resolve(swap.calculatedTokenInfo));
                } else {
                    data = bytes.concat(data, swap.calculatedTokenInfo.id());

                    if (!swap.calculatedTokenInfo.isKnown) {
                        data = bytes.concat(data, bytes20(swap.calculatedTokenInfo.value));
                    }
                }

                uint96 sqrtRatioLimit = swap.sqrtRatioLimit;

                if (testCase.withSqrtRatioLimit) {
                    assertNotEq(sqrtRatioLimit, 0);

                    data = bytes.concat(data, bytes12(sqrtRatioLimit));
                } else {
                    assertEq(sqrtRatioLimit, 0);
                }
            }
        }

        address integrator = testCase.integrationFee.integrator;
        if (testCase.integrationFee.nonZeroShare()) {
            data = bytes.concat(data, bytes2(testCase.integrationFee.share), bytes20(integrator));
        }

        if (testCase.recipient != address(0)) {
            data = bytes.concat(data, bytes20(testCase.recipient));
        }

        (address tokenIn, address tokenOut, address integratorToken) = testCase.isExactOut
            ? (calculatedToken, specifiedToken, specifiedToken)
            : (specifiedToken, calculatedToken, calculatedToken);

        address payer = address(this);
        uint256 value;

        uint256 dealAmount = testCase.isExactOut ? EXACT_OUT_DEAL_AMOUNT : totalSpecified;

        if (tokenIn == NATIVE_TOKEN_ADDRESS) {
            vm.deal(address(this), dealAmount);

            if (!testCase.delegateCall) {
                value = dealAmount;
            }
        } else {
            deal(tokenIn, address(this), dealAmount);
            IERC20(tokenIn).approve(hyperRouter, dealAmount);
        }

        (uint256 payerBalanceBefore, uint256 recipientBalanceBefore, uint128 integratorBalanceBefore) =
            (balanceOf(payer, tokenIn), balanceOf(recipient, tokenOut), savedBalance(integrator, integratorToken));

        (bool success, bytes memory result) =
            testCase.delegateCall ? hyperRouter.delegatecall(data) : hyperRouter.call{value: value}(data);
        vm.snapshotGasLastCall(testCase.tableTestName(tokens));
        assertTrue(success);

        (uint256 calculatedAmount, uint128 integrationFee) = abi.decode(result, (uint256, uint128));

        (uint256 payerBalanceAfter, uint256 recipientBalanceAfter, uint128 integratorBalanceAfter) =
            (balanceOf(payer, tokenIn), balanceOf(recipient, tokenOut), savedBalance(integrator, integratorToken));

        (int256 expectedTokenInDiff, int256 expectedTokenOutDiff) = testCase.isExactOut
            ? (-SafeCastLib.toInt256(calculatedAmount), SafeCastLib.toInt256(totalSpecified))
            : (-SafeCastLib.toInt256(totalSpecified), SafeCastLib.toInt256(calculatedAmount));

        assertEq(
            expectedTokenInDiff, SafeCastLib.toInt256(payerBalanceAfter) - SafeCastLib.toInt256(payerBalanceBefore)
        );
        assertEq(
            expectedTokenOutDiff,
            SafeCastLib.toInt256(recipientBalanceAfter) - SafeCastLib.toInt256(recipientBalanceBefore)
        );
        assertEq(integrationFee, integratorBalanceAfter - integratorBalanceBefore);
    }

    receive() external payable {}

    fallback() external {
        if (msg.sender == CORE_ADDRESS) {
            bytes memory result = LibCall.delegateCallContract(hyperRouter, msg.data);
            uint256 len = result.length;

            assembly ("memory-safe") {
                let free := mload(0x40)
                mcopy(free, add(result, 0x20), len)
                return(free, len)
            }
        } else {
            revert();
        }
    }
}
