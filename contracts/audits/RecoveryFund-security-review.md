# RecoveryFund Security Review

Date: 2026-06-22

## Scope

This review covers the current `RecoveryFund` implementation in:

- `src/RecoveryFund.sol`
- `test/RecoveryFund.t.sol`
- `script/HuffRouterApprovalRecoveryFund.s.sol`

The review focuses on whether a third party can steal claimant funds, steal refunds, or take ownership of the contract. The review also covers the intended zero-owner deployment mode, where claims can remain open forever.

## Summary

No critical, high, or medium severity issues were found in the reviewed `RecoveryFund` contract.

The contract is structured so that:

- Claim authorization is separated from claim execution.
- A valid signature only records that a claimant accepted the claim conditions.
- Only `msg.sender` can spend `recoveryAmount[msg.sender][token]`.
- A relayer can submit a claimant signature, but cannot claim that claimant's allocation.
- The owner can permanently end claims.
- After claims end, anyone can trigger a refund, but refunded assets are sent only to `owner()`.
- If the constructor owner is `address(0)`, no one can end claims, so claims remain open permanently.

## Findings

### Critical

None.

### High

None.

### Medium

None.

### Low / Informational

#### I-1: Zero owner and renounced ownership intentionally make claims permanent

The constructor permits `owner_ == address(0)`. In this mode, `endClaims()` is unreachable because Solady `Ownable.onlyOwner` requires `msg.sender == owner()`, and no external transaction can be sent from `address(0)`.

This matches the intended permanent-claims mode. It also means refunds are unavailable forever because `refund()` requires `claimsEnded == true`.

The inherited `renounceOwnership()` function can also set the owner to `address(0)`. If ownership is renounced before claims end, the contract enters the same permanent-claims mode. If ownership is renounced after claims end, future refunds would be sent to `address(0)`. This is an owner-controlled operational risk, not a third-party exploit.

Recommendation: deploy with `owner_ == address(0)` only when permanent claims are desired. Otherwise, use a durable owner such as a multisig and avoid renouncing ownership after claims have ended unless sending remaining assets to `address(0)` is acceptable.

#### I-2: Claim allocations and contract funding are separate

The constructor records claim allocations, but does not require the contract to be funded at deployment. If the contract is underfunded for a token, claims can revert during transfer even when a claimant has sufficient recorded `recoveryAmount`.

This is not a theft issue. It is an operational funding requirement.

Recommendation: after deployment and funding, compare expected token totals from the claim list with the actual token and ETH balances held by the contract.

## Security Invariants Reviewed

### Claim theft resistance

`claim()` debits only `recoveryAmount[msg.sender][token]`, and then transfers to the recipient chosen by `msg.sender`.

The claimant signature submitted through `agreeToClaimConditions()` does not authorize the relayer to spend the claimant's allocation. It only sets `hasSignedClaimConditions[claimant] = true` after validating the claimant's EIP-712 signature.

Evidence:

- `testRevert_RelayerAgreementDoesNotAuthorizeRelayerToClaim`
- `testRevert_MulticallRelayerCannotAgreeForClaimantAndClaim`
- `testRevert_UnsignedCallerCannotClaim`
- `testRevert_SignedCallerCannotStealAnotherClaimantsFunds`

### Native ETH claim support

Native ETH claims use `token == address(0)`. The claim path sends ETH with `SafeTransferLib.safeTransferETH`.

Evidence:

- `test_ConstructorAllocatesNativeClaim`
- `test_ClaimNativeWithValidSignature`
- `testRevert_ClaimNativeWhenContractNotFunded`

### Claims cannot continue after owner ends claims

Once the owner calls `endClaims()`, `claimsEnded` is permanently set to true. `claim()` checks this flag before reading or reducing the claimant allocation.

Evidence:

- `test_EndClaimsByOwner`
- `testRevert_EndClaimsTwice`
- `testRevert_ClaimErc20AfterClaimsEnded`
- `testRevert_ClaimNativeAfterClaimsEnded`

### Refund theft resistance

`refund()` can be called by anyone after claims end, but the recipient is always `owner()`. The caller does not control the refund recipient.

Evidence:

- `test_RefundErc20AfterClaimsEnded`
- `test_RefundErc20CannotBeStolenByCaller`
- `test_RefundNativeAfterClaimsEnded`
- `test_RefundNativeCannotBeStolenByCaller`

### Ownership takeover resistance

The contract uses Solady `Ownable`. Only the current owner can transfer ownership, complete ownership handover, or end claims. A third party can request ownership handover, but cannot complete it without the current owner.

Evidence:

- `testRevert_NonOwnerCannotTransferOwnership`
- `testRevert_AttackerCannotCompleteOwnOwnershipHandover`
- `test_OwnerCanTransferOwnershipAndNewOwnerControlsClaimsEnd`
- `testRevert_EndClaimsByNonOwner`

### Zero-owner permanent-claims mode

The constructor accepts `address(0)` as owner. In this mode claims remain available, but no third party can end claims or trigger refunds.

Evidence:

- `test_ConstructorAllowsZeroOwnerForPermanentClaims`

## Reentrancy Review

The externally interacting functions update or check contract state before transferring assets:

- `claim()` reduces `recoveryAmount[msg.sender][token]` before transferring ETH or ERC20 tokens.
- `refund()` requires `claimsEnded == true`, so claims cannot be reentered successfully during refund.
- `refund()` always transfers to `owner()`, not to `msg.sender`.

A malicious ETH recipient or token contract may reenter, but the reviewed paths do not allow it to steal another claimant's allocation or redirect refunds to the reentrant caller.

## Assumptions

- Solady `Ownable`, `EIP712`, `Multicallable`, `SafeTransferLib`, and `SignatureCheckerLib` are trusted dependencies.
- Claimants understand that, after signing the claim conditions, they can claim any funded amount up to their allocation to any recipient.
- The owner is trusted to decide when to end claims, unless `owner_ == address(0)` is intentionally used for permanent claims.
- ERC20 tokens used for funding are expected to support ordinary `balanceOf` and `transfer` behavior. Non-standard or malicious tokens may cause their own claim or refund transfers to fail, but should not allow third-party theft under this design.

## Verification

Focused RecoveryFund tests:

```text
forge test --match-path test/RecoveryFund.t.sol
Result: 35 passed, 0 failed, 0 skipped
```

Full test suite:

```text
forge test
Result: 48 passed, 3 failed, 0 skipped
```

The full-suite failures are unrelated to `RecoveryFund`:

- `MAINNET_RPC_URL_OR_ALIAS` is not set for fork-based vulnerable approval canceller tests.
- `tsx` is not installed for SDK testdata generation used by `HuffRouterTest.test_SdkCases`.

## Conclusion

Within the reviewed scope and stated assumptions, the current `RecoveryFund` implementation is suitable for deployment with respect to the reviewed threat model. No exploitable path was found for a third party to steal claims, steal refunds, or take ownership.
