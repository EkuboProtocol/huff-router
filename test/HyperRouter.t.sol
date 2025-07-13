// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {HyperRouter, CORE_ADDRESS, ORACLE_ADDRESS, TWAMM_ADDRESS, MEV_RESIST_ADDRESS} from "../src/HyperRouter.sol";
import {TestCase, MultiHopSwap, Swap, IntegrationFee, PoolConfig} from "./TestCase.sol";
import {LibBit} from "solady/utils/LibBit.sol";
import {LibBytes} from "solady/utils/LibBytes.sol";
import {ICore} from "ekubo/interfaces/ICore.sol";
import {CoreLib} from "ekubo/libraries/CoreLib.sol";
import {readTokensFromFile} from "../src/TokenReader.sol";
import {TokenInfo, resolve} from "./TokenInfo.sol";
import {NATIVE_TOKEN_ADDRESS} from "ekubo/src/math/constants.sol";

using {resolve} for address[];
using CoreLib for ICore;

address constant USDC_ADDRESS = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
address constant USDT_ADDRESS = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
address constant EKUBO_ADDRESS = 0x04C46E830Bb56ce22735d5d8Fc9CB90309317d0f;

bytes32 constant SAVED_BALANCE_SALT = keccak256("HYPER_ROUTER");

ICore constant CORE = ICore(CORE_ADDRESS);

contract HyperRouterTest is Test {
    address hyperRouter;
    address[] tokens;

    bool[2] BOOLS = [true, false];

    receive() external payable {}

    constructor() {
        tokens = readTokensFromFile(vm);
    }

    modifier setUpFork(uint256 blockNumber) {
        vm.createSelectFork(vm.rpcUrl("mainnet"), blockNumber);

        address addr = HyperRouter.deploy(vm);
        hyperRouter = addr;

        uint256 routerCodesize;
        assembly {
            routerCodesize := extcodesize(addr)
        }

        console.log(routerCodesize);

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
        return CORE.savedBalances(token, owner, SAVED_BALANCE_SALT);
    }

    function fixtureTestCase() external view returns (TestCase[] memory cases) {
        cases = new TestCase[](BOOLS.length);

        for (uint256 a = 0; a < BOOLS.length; a++) {
            bool isKnownExtension = BOOLS[a];

            MultiHopSwap[] memory multiHopSwaps = new MultiHopSwap[](1);
            Swap[] memory swaps = new Swap[](1);

            swaps[0] = Swap({
                config: PoolConfig({extension: ORACLE_ADDRESS, fee: 0, tickSpacing: 0}),
                isKnownExtension: isKnownExtension,
                skipAhead: 0,
                calculatedTokenInfo: TokenInfo({value: address(1), isKnown: true}),
                sqrtRatioLimit: 0
            });

            multiHopSwaps[0] = MultiHopSwap({specifiedAmount: 0, swaps: swaps});

            cases[a] = TestCase({
                specifiedTokenInfo: TokenInfo({value: address(0), isKnown: true}),
                calculatedTokenInfo: TokenInfo({value: address(1), isKnown: true}),
                isExactOut: false,
                withSqrtRatioLimit: false,
                multiHopSwaps: multiHopSwaps,
                delegateCall: false,
                recipient: address(0),
                calculatedAmountThreshold: 0,
                integrationFee: IntegrationFee({share: 0, integrator: address(0)}),
                expectedTokenInDiff: 0,
                expectedTokenOutDiff: 0,
                expectedIntegratorDiff: 0
            });
        }
    }

    function tableTestCaseTest(TestCase memory testCase) public setUpFork(22887652) {
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

        for (uint256 i = 0; i < testCase.multiHopSwaps.length; i++) {
            MultiHopSwap memory multiHopSwap = testCase.multiHopSwaps[i];
            uint256 swapCount = multiHopSwap.swaps.length;
            uint256 additionalSwaps = swapCount - 1;

            assertLt(additionalSwaps, type(uint8).max);

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

        IntegrationFee memory integrationFee = testCase.integrationFee;
        address integrator = integrationFee.integrator;
        if (integrationFee.nonZeroShare()) {
            data = bytes.concat(data, bytes2(integrationFee.share), bytes20(integrator));
        }

        if (testCase.recipient != address(0)) {
            data = bytes.concat(data, bytes20(testCase.recipient));
        }

        (address tokenIn, address tokenOut, address integratorToken) = testCase.isExactOut
            ? (calculatedToken, specifiedToken, specifiedToken)
            : (specifiedToken, calculatedToken, calculatedToken);

        (uint256 thisBalanceBefore, uint256 recipientBalanceBefore, uint128 integratorBalanceBefore) = (
            balanceOf(address(this), tokenIn), balanceOf(recipient, tokenOut), savedBalance(integrator, integratorToken)
        );

        (bool success,) = testCase.delegateCall ? hyperRouter.delegatecall(data) : hyperRouter.call(data);
        vm.snapshotGasLastCall(testCase.name(tokens));
        assertTrue(success);

        (uint256 thisBalanceAfter, uint256 recipientBalanceAfter, uint128 integratorBalanceAfter) = (
            balanceOf(address(this), tokenIn), balanceOf(recipient, tokenOut), savedBalance(integrator, integratorToken)
        );

        assertEq(testCase.expectedTokenInDiff, int128(int256(thisBalanceAfter)) - int128(int256(thisBalanceBefore)));
        assertEq(
            testCase.expectedTokenOutDiff,
            int128(int256(recipientBalanceAfter)) - int128(int256(recipientBalanceBefore))
        );
        assertEq(testCase.expectedIntegratorDiff, integratorBalanceAfter - integratorBalanceBefore);
    }

    fallback() external {
        // TODO Forward
    }
}
