// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {VmSafe} from "forge-std/Vm.sol";

uint8 constant TOKEN_COUNT = 90;

function readTokensFromFile(VmSafe vm) view returns (address[] memory tokens) {
    string memory jsonContents = vm.readFile("../tokens/ethereum.json");
    tokens = abi.decode(vm.parseJson(jsonContents, "$..address"), (address[]));

    require(tokens.length == TOKEN_COUNT, string.concat("need exactly ", vm.toString(TOKEN_COUNT), " tokens"));
}
