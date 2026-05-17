// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.33;

import {Test} from "forge-std/Test.sol";

import {VulnerableApprovalCanceller} from "../src/VulnerableApprovalCanceller.sol";
import {VulnerableApprovalCancellerScript} from "../script/VulnerableApprovalCanceller.s.sol";

contract ApprovalSelectionToken {
    mapping(address owner => uint256 balance) public balanceOf;
    mapping(address owner => mapping(address spender => uint256 allowanceAmount)) internal allowances;

    function allowance(address owner, address spender) external view returns (uint256) {
        return allowances[owner][spender];
    }

    function setAllowance(address owner, address spender, uint256 amount) external {
        allowances[owner][spender] = amount;
    }

    function setBalance(address owner, uint256 amount) external {
        balanceOf[owner] = amount;
    }
}

contract VulnerableApprovalCancellerScriptTest is Test {
    address private constant OLD_V2_ROUTER = 0x8F52903D17E2D8d6c77D1A1DE0Cc975b6b5a0D15;
    address private constant NEW_V2_ROUTER = 0x8CCB1ffD5C2aa6Bd926473425Dea4c8c15DE60fd;
    address private constant V3_ROUTER = 0x4F168f17923435c999f5C8565ACAb52C2218EdF2;
    address private constant USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
    address private constant USDT_BLACKLISTED_OWNER = 0x84e6837653c0632f7bD56aF81042dF7Af220c566;

    address private constant V2_CORE = 0xe0e0e08A6A4b9Dc7bD67BCB7aadE5cF48157d444;
    address private constant V3_CORE = 0x00000000000014aA86C5d3c41765bb24e11bd701;

    address private constant TOKEN_A = 0x1111111111111111111111111111111111111111;
    address private constant TOKEN_B = 0x2222222222222222222222222222222222222222;
    address private constant TOKEN_C = 0x3333333333333333333333333333333333333333;
    address private constant TOKEN_D = 0x4444444444444444444444444444444444444444;

    address private constant OWNER_A1 = 0x00000000000000000000000000000000000000A1;
    address private constant OWNER_A2 = 0x00000000000000000000000000000000000000A2;
    address private constant OWNER_B1 = 0x00000000000000000000000000000000000000B1;
    address private constant OWNER_B2 = 0x00000000000000000000000000000000000000b2;
    address private constant OWNER_C1 = 0x00000000000000000000000000000000000000C1;
    address private constant OWNER_D1 = 0x00000000000000000000000000000000000000D1;
    address private constant OWNER_USDT_ALLOWED = 0x00000000000000000000000000000000000000e1;

    VulnerableApprovalCancellerScript private script;

    function setUp() public {
        script = new VulnerableApprovalCancellerScript();

        deployCodeTo("VulnerableApprovalCancellerScript.t.sol:ApprovalSelectionToken", TOKEN_A);
        deployCodeTo("VulnerableApprovalCancellerScript.t.sol:ApprovalSelectionToken", TOKEN_B);
        deployCodeTo("VulnerableApprovalCancellerScript.t.sol:ApprovalSelectionToken", TOKEN_C);
        deployCodeTo("VulnerableApprovalCancellerScript.t.sol:ApprovalSelectionToken", TOKEN_D);
        deployCodeTo("VulnerableApprovalCancellerScript.t.sol:ApprovalSelectionToken", USDT);

        ApprovalSelectionToken(TOKEN_A).setBalance(V2_CORE, 100);
        ApprovalSelectionToken(TOKEN_A).setAllowance(OWNER_A1, NEW_V2_ROUTER, 100);
        ApprovalSelectionToken(TOKEN_A).setAllowance(OWNER_A2, NEW_V2_ROUTER, 101);

        ApprovalSelectionToken(TOKEN_B).setBalance(V2_CORE, 90);
        ApprovalSelectionToken(TOKEN_B).setAllowance(OWNER_B1, NEW_V2_ROUTER, 90);
        ApprovalSelectionToken(TOKEN_B).setAllowance(OWNER_B2, NEW_V2_ROUTER, 0);

        ApprovalSelectionToken(TOKEN_C).setBalance(V3_CORE, uint256(type(uint128).max) + 5);
        ApprovalSelectionToken(TOKEN_C).setAllowance(OWNER_C1, V3_ROUTER, uint256(type(uint128).max) + 1);

        ApprovalSelectionToken(TOKEN_D).setBalance(V3_CORE, 0);
        ApprovalSelectionToken(TOKEN_D).setAllowance(OWNER_D1, V3_ROUTER, 1);

        ApprovalSelectionToken(USDT).setBalance(V2_CORE, 15_000_000);
        ApprovalSelectionToken(USDT).setAllowance(USDT_BLACKLISTED_OWNER, OLD_V2_ROUTER, 10_000_000);
        ApprovalSelectionToken(USDT).setAllowance(OWNER_USDT_ALLOWED, OLD_V2_ROUTER, 5_000_000);
    }

    function test_LoadRouterApprovals_UsesLiveAllowanceAndCoreBalance() external view {
        VulnerableApprovalCanceller.RouterApprovals[] memory batches =
            script.loadRouterApprovals(_fixturePath());

        VulnerableApprovalCanceller.RouterApprovals memory oldV2Batch = _findBatch(batches, OLD_V2_ROUTER);
        VulnerableApprovalCanceller.RouterApprovals memory newV2Batch = _findBatch(batches, NEW_V2_ROUTER);
        VulnerableApprovalCanceller.RouterApprovals memory v3Batch = _findBatch(batches, V3_ROUTER);

        assertEq(oldV2Batch.approvals.length, 1, "old V2 eligible approvals");
        _assertApproval(oldV2Batch.approvals, OWNER_USDT_ALLOWED, USDT, 5_000_000);
        _assertNoApproval(oldV2Batch.approvals, USDT_BLACKLISTED_OWNER, USDT);

        assertEq(newV2Batch.approvals.length, 2, "new V2 eligible approvals");
        _assertApproval(newV2Batch.approvals, OWNER_A1, TOKEN_A, 100);
        _assertApproval(newV2Batch.approvals, OWNER_B1, TOKEN_B, 90);

        assertEq(v3Batch.approvals.length, 0, "v3 eligible approvals");
    }

    function test_DeploymentInfo_FindsAddressWithBeforeSwapBit() external {
        (bytes32 saltA, address deploymentA) = script.deploymentInfo(bytes32(0));
        (bytes32 saltB, address deploymentB) = script.deploymentInfo(bytes32(0));

        assertEq(saltA, saltB, "salt");
        assertEq(deploymentA, deploymentB, "deployment");
        assertTrue((uint8(uint160(deploymentA) >> 152) & 0x40) != 0, "beforeSwap bit");
    }

    function testFork_LoadRouterApprovals_RealIncidentJson() external {
        vm.createSelectFork(vm.envString("MAINNET_RPC_URL_OR_ALIAS"), 25_051_244);

        VulnerableApprovalCancellerScript forkScript = new VulnerableApprovalCancellerScript();
        VulnerableApprovalCanceller.RouterApprovals[] memory batches =
            forkScript.loadRouterApprovals(forkScript.defaultApprovalsPath());

        assertGt(batches.length, 0, "router batches");
        VulnerableApprovalCanceller.RouterApprovals memory oldV2Batch = _findBatch(batches, OLD_V2_ROUTER);
        _assertNoApproval(oldV2Batch.approvals, USDT_BLACKLISTED_OWNER, USDT);
    }

    function _fixturePath() private view returns (string memory) {
        return string.concat(vm.projectRoot(), "/test/fixtures/vulnerable-approvals-fixture.json");
    }

    function _findBatch(
        VulnerableApprovalCanceller.RouterApprovals[] memory batches,
        address router
    ) private pure returns (VulnerableApprovalCanceller.RouterApprovals memory batch) {
        for (uint256 i = 0; i < batches.length; i++) {
            if (batches[i].router == router) {
                return batches[i];
            }
        }

        revert("router batch not found");
    }

    function _assertApproval(
        VulnerableApprovalCanceller.Approval[] memory approvals,
        address owner,
        address token,
        uint128 amount
    ) private pure {
        for (uint256 i = 0; i < approvals.length; i++) {
            VulnerableApprovalCanceller.Approval memory approval = approvals[i];
            if (approval.owner == owner && approval.token == token) {
                assertEq(approval.amount, amount, "approval amount");
                return;
            }
        }

        revert("approval not found");
    }

    function _assertNoApproval(
        VulnerableApprovalCanceller.Approval[] memory approvals,
        address owner,
        address token
    ) private pure {
        for (uint256 i = 0; i < approvals.length; i++) {
            VulnerableApprovalCanceller.Approval memory approval = approvals[i];
            if (approval.owner == owner && approval.token == token) {
                revert("unexpected approval found");
            }
        }
    }
}
