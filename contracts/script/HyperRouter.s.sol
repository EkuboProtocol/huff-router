// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {Script} from "forge-std/Script.sol";
import {HyperRouter} from "../src/HyperRouter.sol";

contract HyperRouterScript is Script {
    function run() external {
        HyperRouter.deploy(vm);
    }
}
