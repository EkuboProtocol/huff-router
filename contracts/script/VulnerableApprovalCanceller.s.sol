// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.33;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";

import {VulnerableApprovalCanceller} from "../src/VulnerableApprovalCanceller.sol";

contract VulnerableApprovalCancellerScript is Script {
    uint8 internal constant BEFORE_SWAP_MASK = 0x40;

    address internal constant OLD_V2_ROUTER = 0x8F52903D17E2D8d6c77D1A1DE0Cc975b6b5a0D15;
    address internal constant NEW_V2_ROUTER = 0x8CCB1ffD5C2aa6Bd926473425Dea4c8c15DE60fd;
    address internal constant V3_ROUTER = 0x4F168f17923435c999f5C8565ACAb52C2218EdF2;
    address internal constant USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
    address internal constant USDT_BLACKLISTED_OWNER = 0x84e6837653c0632f7bD56aF81042dF7Af220c566;

    address internal constant V2_CORE = 0xe0e0e08A6A4b9Dc7bD67BCB7aadE5cF48157d444;
    address internal constant V3_CORE = 0x00000000000014aA86C5d3c41765bb24e11bd701;

    error BeforeSwapBitNotSet(address deployment);
    error ERC20AllowanceReadFailed(address token, address owner, address spender);
    error ERC20BalanceReadFailed(address token, address owner);
    error UnexpectedDeploymentCode(address deployment);
    error UnsupportedRouter(address router);

    struct JsonApprovalEntry {
        string amount;
        string effective;
        string owner;
    }

    struct ParsedApprovalEntry {
        string amount;
        string effective;
        address owner;
    }

    function run() external {
        string memory approvalsPath = vm.envOr("VULNERABLE_APPROVALS_FILE", defaultApprovalsPath());
        bytes32 startingSalt = vm.envOr("VULNERABLE_APPROVAL_CANCELLER_SALT", bytes32(0));

        VulnerableApprovalCanceller.RouterApprovals[] memory batches = loadRouterApprovals(approvalsPath);
        (bytes32 salt, address predictedDeployment) = deploymentInfo(startingSalt);

        console2.log("Approvals file:", approvalsPath);
        console2.log("Canceller deployment:", predictedDeployment);
        console2.logBytes32(salt);

        if (predictedDeployment.code.length != 0) {
            _assertDeploymentCode(predictedDeployment);
        }

        bool needsDeploy = predictedDeployment.code.length == 0;
        bool needsCancellation = false;

        for (uint256 i = 0; i < batches.length; i++) {
            console2.log("Router", batches[i].router);
            console2.log("Eligible approvals", batches[i].approvals.length);
            if (batches[i].approvals.length != 0) {
                needsCancellation = true;
            }
        }

        if (!needsDeploy && !needsCancellation) {
            console2.log("Nothing to do.");
            return;
        }

        vm.startBroadcast();

        VulnerableApprovalCanceller canceller = VulnerableApprovalCanceller(predictedDeployment);
        if (needsDeploy) {
            canceller = new VulnerableApprovalCanceller{salt: salt}();
            _assertBeforeSwapBit(address(canceller));
            console2.log("Deployed canceller at", address(canceller));
        }

        if (needsCancellation) {
            for (uint256 i = 0; i < batches.length; i++) {
                if (batches[i].approvals.length == 0) {
                    continue;
                }

                console2.log("Cancelling approvals for router", batches[i].router, batches[i].approvals.length);
            }

            canceller.cancelApprovals(batches);
        }

        vm.stopBroadcast();
    }

    function defaultApprovalsPath() public view returns (string memory) {
        return string.concat(vm.projectRoot(), "/../sdk/incident-analysis/vulnerable-approvals.json");
    }

    function deploymentInfo(bytes32 startingSalt) public returns (bytes32 salt, address predictedDeployment) {
        bytes32 initCodeHash = keccak256(type(VulnerableApprovalCanceller).creationCode);
        salt = startingSalt;

        while (true) {
            predictedDeployment = vm.computeCreate2Address(salt, initCodeHash);
            if (_beforeSwapBitIsSet(predictedDeployment)) {
                break;
            }

            salt = bytes32(uint256(salt) + 1);
        }
    }

    function loadRouterApprovals(string memory approvalsPath)
        public
        view
        returns (VulnerableApprovalCanceller.RouterApprovals[] memory batches)
    {
        string memory json = vm.readFile(approvalsPath);
        string[] memory routerKeys = vm.parseJsonKeys(json, ".");

        batches = new VulnerableApprovalCanceller.RouterApprovals[](routerKeys.length);
        for (uint256 i = 0; i < routerKeys.length; i++) {
            address router = vm.parseAddress(routerKeys[i]);
            string memory routerPath = _jsonKeyPath(".", routerKeys[i]);

            batches[i] = VulnerableApprovalCanceller.RouterApprovals({
                router: router,
                approvals: _loadEligibleApprovalsForRouter(json, routerPath, router, _coreForRouter(router))
            });
        }
    }

    function _loadEligibleApprovalsForRouter(
        string memory json,
        string memory routerPath,
        address router,
        address core
    ) internal view returns (VulnerableApprovalCanceller.Approval[] memory approvals) {
        string[] memory tokenKeys = vm.parseJsonKeys(json, routerPath);
        uint256 eligibleCount;

        for (uint256 i = 0; i < tokenKeys.length; i++) {
            address token = vm.parseAddress(tokenKeys[i]);
            uint256 coreBalance = _readBalanceOf(token, core);
            if (coreBalance == 0) {
                continue;
            }

            ParsedApprovalEntry[] memory entries = _loadEntries(json, _jsonKeyPath(routerPath, tokenKeys[i]));
            for (uint256 j = 0; j < entries.length; j++) {
                if (_isExcludedApproval(token, entries[j].owner)) {
                    continue;
                }

                uint256 allowance = _readAllowance(token, entries[j].owner, router);
                if (_isEligibleApproval(allowance, coreBalance)) {
                    eligibleCount++;
                }
            }
        }

        approvals = new VulnerableApprovalCanceller.Approval[](eligibleCount);
        uint256 approvalIndex;

        for (uint256 i = 0; i < tokenKeys.length; i++) {
            address token = vm.parseAddress(tokenKeys[i]);
            uint256 coreBalance = _readBalanceOf(token, core);
            if (coreBalance == 0) {
                continue;
            }

            ParsedApprovalEntry[] memory entries = _loadEntries(json, _jsonKeyPath(routerPath, tokenKeys[i]));
            for (uint256 j = 0; j < entries.length; j++) {
                if (_isExcludedApproval(token, entries[j].owner)) {
                    continue;
                }

                uint256 allowance = _readAllowance(token, entries[j].owner, router);
                if (!_isEligibleApproval(allowance, coreBalance)) {
                    continue;
                }

                approvals[approvalIndex] = VulnerableApprovalCanceller.Approval({
                    token: token,
                    owner: entries[j].owner,
                    amount: uint128(allowance)
                });
                approvalIndex++;
            }
        }
    }

    function _loadEntries(string memory json, string memory path) internal view returns (ParsedApprovalEntry[] memory entries) {
        uint256 entryCount;
        while (vm.keyExistsJson(json, _jsonArrayIndexPath(path, entryCount))) {
            entryCount++;
        }

        entries = new ParsedApprovalEntry[](entryCount);
        for (uint256 i = 0; i < entryCount; i++) {
            string memory entryPath = _jsonArrayIndexPath(path, i);
            entries[i] = ParsedApprovalEntry({
                amount: vm.parseJsonString(json, string.concat(entryPath, ".amount")),
                effective: vm.parseJsonString(json, string.concat(entryPath, ".effective")),
                owner: vm.parseAddress(vm.parseJsonString(json, string.concat(entryPath, ".owner")))
            });
        }
    }

    function _coreForRouter(address router) internal pure returns (address core) {
        if (router == OLD_V2_ROUTER || router == NEW_V2_ROUTER) {
            return V2_CORE;
        }
        if (router == V3_ROUTER) {
            return V3_CORE;
        }

        revert UnsupportedRouter(router);
    }

    function _isEligibleApproval(uint256 allowance, uint256 coreBalance) internal pure returns (bool) {
        return allowance != 0 && allowance <= coreBalance && allowance <= type(uint128).max;
    }

    function _isExcludedApproval(address token, address owner) internal pure returns (bool) {
        return token == USDT && owner == USDT_BLACKLISTED_OWNER;
    }

    function _assertDeploymentCode(address deployment) internal view {
        if (deployment.codehash != keccak256(type(VulnerableApprovalCanceller).runtimeCode)) {
            revert UnexpectedDeploymentCode(deployment);
        }

        _assertBeforeSwapBit(deployment);
    }

    function _assertBeforeSwapBit(address deployment) internal pure {
        if (!_beforeSwapBitIsSet(deployment)) {
            revert BeforeSwapBitNotSet(deployment);
        }
    }

    function _beforeSwapBitIsSet(address deployment) internal pure returns (bool) {
        return (uint8(uint160(deployment) >> 152) & BEFORE_SWAP_MASK) != 0;
    }

    function _jsonKeyPath(string memory prefix, string memory key) internal pure returns (string memory) {
        return string.concat(prefix, "[\"", key, "\"]");
    }

    function _jsonArrayIndexPath(string memory prefix, uint256 index) internal pure returns (string memory) {
        return string.concat(prefix, "[", vm.toString(index), "]");
    }

    function _readAllowance(address token, address owner, address spender) internal view returns (uint256 allowance) {
        (bool success, bytes memory returndata) =
            token.staticcall(abi.encodeCall(IERC20.allowance, (owner, spender)));
        if (!success || returndata.length < 32) {
            revert ERC20AllowanceReadFailed(token, owner, spender);
        }

        allowance = abi.decode(returndata, (uint256));
    }

    function _readBalanceOf(address token, address owner) internal view returns (uint256 balance) {
        (bool success, bytes memory returndata) = token.staticcall(abi.encodeCall(IERC20.balanceOf, (owner)));
        if (!success || returndata.length < 32) {
            revert ERC20BalanceReadFailed(token, owner);
        }

        balance = abi.decode(returndata, (uint256));
    }
}
