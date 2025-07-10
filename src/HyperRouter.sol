// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {HuffNeoConfig} from "foundry-huff-neo/HuffNeoConfig.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {CORE_ADDRESS, ORACLE_ADDRESS, TWAMM_ADDRESS, MEV_RESIST_ADDRESS} from "./chains/mainnet.sol";

uint8 constant ALPHABET_LENGTH = 26;
uint8 constant UPPERCASE_LETTER_START = 65;
uint8 constant TOKEN_COUNT = 90;

library HyperRouter {
    function deploy(VmSafe vm) internal returns (address) {
        string memory jsonContents = vm.readFile("src/tokens.json");
        address[] memory addresses = abi.decode(vm.parseJson(jsonContents, "$..address"), (address[]));

        require(addresses.length == TOKEN_COUNT, string.concat("need exactly ", vm.toString(TOKEN_COUNT), " tokens"));

        // We don't use HuffNeoDeployer because of https://github.com/foundry-rs/foundry/issues/6215
        HuffNeoConfig config = new HuffNeoConfig().set_broadcast(true).with_addr_constant("CORE", CORE_ADDRESS)
            .with_addr_constant("ORACLE", ORACLE_ADDRESS).with_addr_constant("TWAMM", TWAMM_ADDRESS).with_addr_constant(
            "MEV_RESIST", MEV_RESIST_ADDRESS
        );

        for (uint8 i = 0; i < TOKEN_COUNT; i++) {
            string memory name = string.concat(
                "TOKEN_", letterFromAsciiOffset(i / ALPHABET_LENGTH), letterFromAsciiOffset(i % ALPHABET_LENGTH)
            );

            config = config.with_addr_constant(name, addresses[i]);
        }

        return config.deploy("src/HyperRouter.huff");
    }

    function letterFromAsciiOffset(uint8 offset) private pure returns (string memory s) {
        s = string(bytes.concat(bytes1(UPPERCASE_LETTER_START + offset)));
    }
}
