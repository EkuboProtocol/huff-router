// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {HyperRouter} from "../src/HyperRouter.sol";
import {Script} from "forge-std/Script.sol";

contract HyperRouterScript is Script {
    function run() external {
        HyperRouter.deploy(vm);
    }
}
