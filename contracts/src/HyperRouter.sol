// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {CORE_ADDRESS, MEV_CAPTURE_ADDRESS, ORACLE_ADDRESS, TWAMM_ADDRESS} from "./addresses.sol";
import {ILocker} from "ekubo/interfaces/IFlashAccountant.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {HuffNeoConfig} from "foundry-huff-neo/HuffNeoConfig.sol";

// TODO Generate with hnc
interface IHyperRouter is ILocker {
    error SlippageCheckFailed(uint256 calculatedAmount);
    error NativeTransferFailed();
    error CoreOnly();

    function claimIntegrationFees(address[] calldata tokens) external returns (uint256[] calldata claimedAmounts);
}

library HyperRouterLib {
    struct SwapReturndata {
        uint256 calculatedAmount;
        uint128 integrationFee;
    }

    string private constant _TOKENS_FILE_NAME = "src/locked/tokens.huff";

    // TODO --relax-jumps
    function deploy(VmSafe vm) internal returns (IHyperRouter) {
        // We don't use HuffNeoDeployer because of https://github.com/foundry-rs/foundry/issues/6215
        HuffNeoConfig config = new HuffNeoConfig().set_broadcast(true).with_addr_constant("CORE", CORE_ADDRESS)
            .with_addr_constant("ORACLE", ORACLE_ADDRESS).with_addr_constant("TWAMM", TWAMM_ADDRESS)
            .with_addr_constant("MEV_CAPTURE", MEV_CAPTURE_ADDRESS);

        string memory jsonContents = vm.readFile(string.concat("../tokens/", vm.toString(block.chainid), ".json"));

        config = _setTokens(vm, abi.decode(vm.parseJson(jsonContents), (address[])), config);

        return IHyperRouter(config.deploy("src/HyperRouter.huff"));
    }

    function decodeSwapReturndata(bytes memory data) internal pure returns (SwapReturndata memory returndata) {
        returndata = abi.decode(data, (SwapReturndata));
    }

    function _setTokens(VmSafe vm, address[] memory tokens, HuffNeoConfig config) private returns (HuffNeoConfig) {
        string memory data = "#define table TOKENS {";
        for (uint256 i = 0; i < tokens.length; i++) {
            string memory constantName = string.concat("TOKEN_", vm.toString(i));

            data = string.concat(data, "    [", constantName, "]");
            config = config.with_addr_constant(constantName, tokens[i]);
        }
        data = string.concat(data, "}");

        vm.writeFile(_TOKENS_FILE_NAME, string.concat(data));

        return config;
    }
}
