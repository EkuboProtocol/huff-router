// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {VulnerableApprovalCanceller} from "../src/VulnerableApprovalCanceller.sol";

import {Test} from "forge-std/Test.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";

contract VulnerableApprovalCancellerTest is Test {
    struct TestParams {
        address router;
        address owner;
        address token;
        uint128 amount;
    }

    address private constant OLD_V2_ROUTER = 0x8F52903D17E2D8d6c77D1A1DE0Cc975b6b5a0D15;
    address private constant NEW_V2_ROUTER = 0x8CCB1ffD5C2aa6Bd926473425Dea4c8c15DE60fd;
    address private constant V3_ROUTER = 0x4F168f17923435c999f5C8565ACAb52C2218EdF2;

    uint256 private constant FORK_BLOCK = 25_051_244;

    VulnerableApprovalCanceller private canceller;

    function setUp() public {
        vm.createSelectFork(vm.envString("MAINNET_RPC_URL_OR_ALIAS"), FORK_BLOCK);
        canceller = new VulnerableApprovalCanceller();
    }

    function test_CancelApprovals_OldV2() external {
        testCancellation(TestParams({
            router: OLD_V2_ROUTER,
            owner: 0x32e3Adf4B53D74510FFDD12bC480e7Eac3Be4964,
            token: 0x04C46E830Bb56ce22735d5d8Fc9CB90309317d0f,
            amount: 666179441537678020
        }));
    }

    function test_CancelApprovals_NewV2() external {
        testCancellation(TestParams({
            router: NEW_V2_ROUTER,
            owner: 0x963d48195006629408EBfD07c7F29E225027e611,
            token: 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48,
            amount: 236676
        }));
    }

    function test_CancelApprovals_V3() external {
        testCancellation(TestParams({
            router: V3_ROUTER,
            owner: 0x59653fd9713a30C54237A6FD21fD97BA141aBbe0,
            token: 0x04C46E830Bb56ce22735d5d8Fc9CB90309317d0f,
            amount: 2257373815389
        }));
    }

    function testCancellation(TestParams memory t) private {
        IERC20 token = IERC20(t.token);

        uint256 ownerBalanceBefore = token.balanceOf(t.owner);
        uint256 routerAllowanceBefore = token.allowance(t.owner, t.router);

        assertGe(routerAllowanceBefore, t.amount, "insufficient starting allowance");

        VulnerableApprovalCanceller.Approval[] memory approvals = new VulnerableApprovalCanceller.Approval[](1);
        approvals[0] = VulnerableApprovalCanceller.Approval({token: t.token, owner: t.owner, amount: t.amount});
        VulnerableApprovalCanceller.RouterApprovals[] memory routerApprovalsArr =
            new VulnerableApprovalCanceller.RouterApprovals[](1);
        routerApprovalsArr[0] =
            VulnerableApprovalCanceller.RouterApprovals({router: t.router, approvals: approvals});

        canceller.cancelApprovals(routerApprovalsArr);

        uint256 ownerBalanceAfter = token.balanceOf(t.owner);
        uint256 routerAllowanceAfter = token.allowance(t.owner, t.router);

        assertEq(ownerBalanceAfter, ownerBalanceBefore, "owner balance");
        assertEq(routerAllowanceBefore - routerAllowanceAfter, t.amount, "allowance delta");
    }
}
