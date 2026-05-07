// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {HuffRouterLib} from "../src/HuffRouter.sol";
import {Script} from "forge-std/Script.sol";

contract HuffRouterScript is Script {
    function run() external {
        HuffRouterLib.deploy(vm);
    }
}
