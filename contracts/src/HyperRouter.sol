// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {CORE_ADDRESS, MEV_CAPTURE_ADDRESS, ORACLE_ADDRESS, TWAMM_ADDRESS} from "./addresses.sol";
import {ILocker} from "ekubo/interfaces/IFlashAccountant.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {HuffNeoConfig} from "foundry-huff-neo/HuffNeoConfig.sol";

// TODO Generate with hnc
interface IHyperRouter is ILocker {
    error SlippageCheckFailed(uint256 calculatedAmount);
    error ETHTransferFailed();
    error CoreOnly();

    function claimIntegrationFees(address[] calldata tokens) external returns (uint256[] calldata claimedAmounts);
}

library HyperRouterLib {
    struct SwapReturndata {
        uint256 calculatedAmount;
        uint128 integrationFee;
    }

    uint8 private constant _TOKEN_COUNT = 91;
    uint8 private constant _ALPHABET_LENGTH = 26;
    uint8 private constant _UPPERCASE_LETTER_START = 65;

    // TODO --relax-jumps
    function deploy(VmSafe vm) internal returns (IHyperRouter) {
        string memory jsonContents = vm.readFile(string.concat("../tokens/", vm.toString(block.chainid), ".json"));
        address[] memory tokens = abi.decode(vm.parseJson(jsonContents, "$..address"), (address[]));

        require(tokens.length == _TOKEN_COUNT, string.concat("need exactly ", vm.toString(_TOKEN_COUNT), " tokens"));

        // We don't use HuffNeoDeployer because of https://github.com/foundry-rs/foundry/issues/6215
        HuffNeoConfig config = new HuffNeoConfig().set_broadcast(true).with_addr_constant("CORE", CORE_ADDRESS)
            .with_addr_constant("ORACLE", ORACLE_ADDRESS).with_addr_constant("TWAMM", TWAMM_ADDRESS)
            .with_addr_constant("MEV_CAPTURE", MEV_CAPTURE_ADDRESS);

        // TODO Use numbers & allow variable amounts of tokens per deployment
        for (uint8 i = 0; i < _TOKEN_COUNT; i++) {
            string memory name = string.concat(
                "TOKEN_", _letterFromAsciiOffset(i / _ALPHABET_LENGTH), _letterFromAsciiOffset(i % _ALPHABET_LENGTH)
            );

            config = config.with_addr_constant(name, tokens[i]);
        }

        return IHyperRouter(config.deploy("src/HyperRouter.huff"));
    }

    function decodeSwapReturndata(bytes memory data) internal pure returns (SwapReturndata memory returndata) {
        returndata = abi.decode(data, (SwapReturndata));
    }

    function _letterFromAsciiOffset(uint8 offset) private pure returns (string memory s) {
        s = string(bytes.concat(bytes1(_UPPERCASE_LETTER_START + offset)));
    }
}
