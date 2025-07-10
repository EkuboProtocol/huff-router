// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {HyperRouter} from "../src/HyperRouter.sol";
import {CORE_ADDRESS, ORACLE_ADDRESS} from "../src/chains/mainnet.sol";

address constant NATIVE_TOKEN_ADDRESS = 0x0000000000000000000000000000000000000000;
address constant USDC_ADDRESS = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
address constant USDT_ADDRESS = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
address constant EKUBO_ADDRESS = 0x04C46E830Bb56ce22735d5d8Fc9CB90309317d0f;

contract HyperRouterTest is Test {
    address hyperRouter;

    receive() external payable {}

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

    function balanceOf(address token) private view returns (uint256 balance) {
        if (token == NATIVE_TOKEN_ADDRESS) {
            balance = address(this).balance;
        } else {
            balance = IERC20(token).balanceOf(address(this));
        }
    }

    function test_shortestCalldata() external setUpFork(22887652) {
        uint256 value = 1_000;

        (bool success,) = hyperRouter.call{value: value}(
            bytes.concat(
                hex"00", // withRecipient
                hex"00", // specifiedAmountBytes
                hex"00", // calculatedAmountThresholdBytes
                hex"00", // specifiedTokenInfo
                hex"01", // calculatedTokenInfo
                hex"00", // additionalMultiHopSwaps
                hex"00", // withIntegrationFee
                hex"00", // withSqrtRatioLimit | isExactOut
                hex"00", // additionalSwaps
                hex"01" // extensionInfo
            )
        );

        console.log(success);
    }
}
