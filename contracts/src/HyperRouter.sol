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
    string private constant _ENTRY_POINT_FILE_NAME = "src/HyperRouter.huff";

    function initcodeSize(VmSafe vm) internal returns (uint256) {
        return _config(vm).creation_code_with_args(_ENTRY_POINT_FILE_NAME).length;
    }

    // TODO --relax-jumps
    function deploy(VmSafe vm) internal returns (IHyperRouter) {
        return IHyperRouter(_config(vm).deploy(_ENTRY_POINT_FILE_NAME));
    }

    function decodeSwapReturndata(bytes memory data) internal pure returns (SwapReturndata memory returndata) {
        returndata = abi.decode(data, (SwapReturndata));
    }

    function _config(VmSafe vm) private returns (HuffNeoConfig) {
        // We don't use HuffNeoDeployer because of https://github.com/foundry-rs/foundry/issues/6215
        HuffNeoConfig cfg = new HuffNeoConfig().set_broadcast(true).with_addr_constant("CORE", CORE_ADDRESS)
            .with_addr_constant("ORACLE", ORACLE_ADDRESS).with_addr_constant("TWAMM", TWAMM_ADDRESS)
            .with_addr_constant("MEV_CAPTURE", MEV_CAPTURE_ADDRESS);

        string memory jsonContents = vm.readFile(string.concat("../tokens/", vm.toString(block.chainid), ".json"));

        return _setTokens(vm, abi.decode(vm.parseJson(jsonContents), (address[])), cfg);
    }

    function _setTokens(VmSafe vm, address[] memory tokens, HuffNeoConfig cfg) private returns (HuffNeoConfig) {
        string memory data = "#define table TOKENS {";
        for (uint256 i = 0; i < tokens.length; i++) {
            string memory constantName = string.concat("TOKEN_", vm.toString(i));

            data = string.concat(data, "    [", constantName, "]");
            cfg = cfg.with_addr_constant(constantName, tokens[i]);
        }
        data = string.concat(data, "}");

        vm.writeFile(_TOKENS_FILE_NAME, string.concat(data));

        return cfg;
    }
}
