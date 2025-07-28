// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {ILocker, IPayer} from "ekubo/interfaces/IFlashAccountant.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {HuffNeoConfig} from "foundry-huff-neo/HuffNeoConfig.sol";

address constant CORE_ADDRESS = 0xe0e0e08A6A4b9Dc7bD67BCB7aadE5cF48157d444;
address constant ORACLE_ADDRESS = 0x51d02A5948496a67827242EaBc5725531342527C;
address constant TWAMM_ADDRESS = 0xD4279c050DA1F5c5B2830558C7A08E57e12b54eC;
address constant MEV_RESIST_ADDRESS = 0x553a2EFc570c9e104942cEC6aC1c18118e54C091;

interface IHyperRouter is ILocker, IPayer {
    error SlippageCheckFailed(int128 calculatedAmount);
    error ETHTransferFailed();
    error CoreOnly();
}

library HyperRouterLib {
    struct Returndata {
        uint256 calculatedAmount;
        uint128 integrationFee;
    }

    uint8 private constant _TOKEN_COUNT = 90;
    uint8 private constant _ALPHABET_LENGTH = 26;
    uint8 private constant _UPPERCASE_LETTER_START = 65;

    function deploy(VmSafe vm) internal returns (IHyperRouter) {
        string memory jsonContents = vm.readFile("../tokens/ethereum.json");
        address[] memory tokens = abi.decode(vm.parseJson(jsonContents, "$..address"), (address[]));

        require(tokens.length == _TOKEN_COUNT, string.concat("need exactly ", vm.toString(_TOKEN_COUNT), " tokens"));

        // We don't use HuffNeoDeployer because of https://github.com/foundry-rs/foundry/issues/6215
        HuffNeoConfig config = new HuffNeoConfig().set_broadcast(true).with_addr_constant("CORE", CORE_ADDRESS)
            .with_addr_constant("ORACLE", ORACLE_ADDRESS).with_addr_constant("TWAMM", TWAMM_ADDRESS).with_addr_constant(
            "MEV_RESIST", MEV_RESIST_ADDRESS
        );

        for (uint8 i = 0; i < _TOKEN_COUNT; i++) {
            string memory name = string.concat(
                "TOKEN_", _letterFromAsciiOffset(i / _ALPHABET_LENGTH), _letterFromAsciiOffset(i % _ALPHABET_LENGTH)
            );

            config = config.with_addr_constant(name, tokens[i]);
        }

        return IHyperRouter(config.deploy("src/HyperRouter.huff"));
    }

    function decodeReturndata(bytes memory data) internal pure returns (Returndata memory returndata) {
        returndata = abi.decode(data, (Returndata));
    }

    function _letterFromAsciiOffset(uint8 offset) private pure returns (string memory s) {
        s = string(bytes.concat(bytes1(_UPPERCASE_LETTER_START + offset)));
    }
}
