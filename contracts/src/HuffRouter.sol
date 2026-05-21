// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {CreateHuffRouter} from "./CreateHuffRouter.sol";
import {CORE_ADDRESS, MEV_CAPTURE_ADDRESS, ORACLE_ADDRESS, TWAMM_ADDRESS} from "./addresses.sol";
import {ILocker} from "ekubo/interfaces/IFlashAccountant.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {HuffNeoConfig} from "foundry-huff-neo/HuffNeoConfig.sol";

// TODO Generate with hnc
interface IHuffRouter is ILocker {
    error Expired(uint256 expiry);
    error SlippageCheckFailed(uint256 calculatedAmount);
    error NativeTransferFailed();
    error CoreOnly();

    function claimIntegrationFees(address[] calldata tokens) external returns (uint256[] calldata claimedAmounts);
}

library HuffRouterLib {
    struct SwapReturndata {
        uint256 calculatedAmount;
        uint128 integrationFee;
    }

    uint256 public constant IMMUTABLES_OFFSET = 19918;

    string private constant _ENTRY_POINT_FILE_NAME = "src/HuffRouter.huff";

    function initcodeSize() internal returns (uint256) {
        return _config(false).creation_code_with_args(_ENTRY_POINT_FILE_NAME).length;
    }

    function deployFactory(bool broadcast) internal returns (CreateHuffRouter factory) {
        factory = new CreateHuffRouter(_creationCode(broadcast));
    }

    // TODO Add disclaimer
    function deployIsolated() internal returns (IHuffRouter router) {
        router = IHuffRouter(_config(false).deploy(_ENTRY_POINT_FILE_NAME));
    }

    function decodeSwapReturndata(bytes memory data) internal pure returns (SwapReturndata memory returndata) {
        returndata = abi.decode(data, (SwapReturndata));
    }

    function getTokenList(VmSafe vm) internal view returns (address[] memory) {
        string memory jsonContents = vm.readFile(string.concat("../tokens/", vm.toString(block.chainid), ".json"));
        return abi.decode(vm.parseJson(jsonContents), (address[]));
    }

    // TODO --relax-jumps
    function _config(bool broadcast) private returns (HuffNeoConfig) {
        // We don't use HuffNeoDeployer because of https://github.com/foundry-rs/foundry/issues/6215
        return new HuffNeoConfig().set_broadcast(broadcast).with_deployer(address(this))
            .with_addr_constant("CORE", CORE_ADDRESS).with_addr_constant("ORACLE", ORACLE_ADDRESS)
            .with_addr_constant("TWAMM", TWAMM_ADDRESS).with_addr_constant("MEV_CAPTURE", MEV_CAPTURE_ADDRESS)
            .with_uint_constant("IMMUTABLES_CODE_OFFSET", IMMUTABLES_OFFSET);
    }

    function _creationCode(bool broadcast) private returns (bytes memory) {
        return _config(broadcast).creation_code(_ENTRY_POINT_FILE_NAME);
    }
}
