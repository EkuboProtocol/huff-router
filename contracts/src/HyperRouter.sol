// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {TOKEN_COUNT, readTokensFromFile} from "./TokenReader.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {HuffNeoConfig} from "foundry-huff-neo/HuffNeoConfig.sol";

address constant CORE_ADDRESS = 0xe0e0e08A6A4b9Dc7bD67BCB7aadE5cF48157d444;
address constant ORACLE_ADDRESS = 0x51d02A5948496a67827242EaBc5725531342527C;
address constant TWAMM_ADDRESS = 0xD4279c050DA1F5c5B2830558C7A08E57e12b54eC;
address constant MEV_RESIST_ADDRESS = 0x553a2EFc570c9e104942cEC6aC1c18118e54C091;

library HyperRouter {
    uint8 constant ALPHABET_LENGTH = 26;
    uint8 constant UPPERCASE_LETTER_START = 65;

    function deploy(VmSafe vm) internal returns (address) {
        address[] memory tokens = readTokensFromFile(vm);

        // We don't use HuffNeoDeployer because of https://github.com/foundry-rs/foundry/issues/6215
        HuffNeoConfig config = new HuffNeoConfig().set_broadcast(true).with_addr_constant("CORE", CORE_ADDRESS)
            .with_addr_constant("ORACLE", ORACLE_ADDRESS).with_addr_constant("TWAMM", TWAMM_ADDRESS).with_addr_constant(
            "MEV_RESIST", MEV_RESIST_ADDRESS
        );

        for (uint8 i = 0; i < TOKEN_COUNT; i++) {
            string memory name = string.concat(
                "TOKEN_", letterFromAsciiOffset(i / ALPHABET_LENGTH), letterFromAsciiOffset(i % ALPHABET_LENGTH)
            );

            config = config.with_addr_constant(name, tokens[i]);
        }

        return config.deploy("src/HyperRouter.huff");
    }

    function letterFromAsciiOffset(uint8 offset) private pure returns (string memory s) {
        s = string(bytes.concat(bytes1(UPPERCASE_LETTER_START + offset)));
    }
}
