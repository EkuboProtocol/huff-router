# HuffRouter TransferFrom Invariant Audit

Date: 2026-07-02

## Scope

This audit covers the current working-tree version of the HuffRouter transfer settlement path, with focus on this invariant:

> Whenever the router calls ERC20 `transferFrom(address from, address to, uint256 amount)`, `from` must be the original caller of the router entrypoint.

Reviewed files:

- `contracts/src/HuffRouter.huff`
- `contracts/src/lock/swap.huff`
- `contracts/src/locked/swap.huff`
- `contracts/test/HuffRouter.t.sol`
- `contracts/foundry.toml`

The review is scoped to the ERC20 settlement surface, the callback data boundary between `LOCK_SWAP` and `LOCKED_SWAP`, and regression/static tests that verify the transfer surface. It is not a full audit of route parsing, swap arithmetic, Ekubo Core, extensions, token wrapper semantics, or all SDK calldata generation.

## Method

The audit method was:

1. Manual review of router dispatch and Core callback gating.
2. Manual review of `LOCK_SWAP` callback calldata construction, especially the appended caller word.
3. Manual review of `LOCKED_SWAP` ERC20 settlement, including the `transfer` and `transferFrom` branches.
4. Source-shape search for all router `transfer`, `transferFrom`, `tstore`, `tload`, caller, and calldata-end references.
5. Runtime regression testing of the previous trailing-calldata approval-drain shape.
6. Static test coverage that pins the expected source shape for future changes.
7. Focused Foundry test execution and full-suite execution to identify unrelated blockers.

No transient storage was introduced or relied on for this invariant.

## Summary

No critical, high, or medium severity issues were found in the reviewed transfer settlement surface of this version.

The reviewed code preserves both intended ERC20 payment modes:

- `transfer(address to, uint256 amount)` is still available when the callback transfer-from word is zero. This is useful for delegatecall-style use where tokens are held by the executing contract only transiently.
- `transferFrom(address from, address to, uint256 amount)` is still available when the callback transfer-from word is nonzero.

The `transferFrom` branch is constrained so the `from` argument is loaded from the last word of callback calldata. That word is appended by `LOCK_SWAP` from `caller`, i.e. the router entrypoint's caller in ordinary calls, or the delegating context's caller under delegatecall execution.

## Findings

### Critical

None.

### High

None.

### Medium

None.

### Low / Informational

#### I-1: Static source-shape test is intentionally narrow

`test_StaticTransferFromSurface` verifies exact source substrings for the transfer surface. This is useful for auditability and for catching accidental reintroduction of additional `transferFrom` surfaces, but it is not a formal proof over compiled bytecode.

Recommendation: keep this test as a regression guard, and treat any future failure as a prompt for manual audit of the transfer settlement path.

## Invariant Review

### External callback access

The `locked_6416899205(uint256)` callback path is guarded by `CORE_CHECK()` in `contracts/src/HuffRouter.huff`, so callers other than Core cannot directly enter `LOCKED_SWAP` settlement.

Evidence:

- `testRevert_LockedCoreOnly`
- `testRevert_ZeroLengthCalldata`

### Original caller append

`LOCK_SWAP_1` appends the current `caller` as an ABI-encoded word after the route calldata. This appended word is the only reviewed source for the `transferFrom` address consumed by ERC20 settlement.

Evidence:

- `contracts/src/lock/swap.huff`: `caller // [transferFrom]`
- `contracts/src/lock/swap.huff`: `calldatasize add // [transferFromOffset, transferFrom]`
- `test_StaticTransferFromSurface`

### TransferFrom branch source

`PAY_ERC20` loads the last word of callback calldata with:

```text
[WORD_SIZE] calldatasize sub calldataload
```

If that word is nonzero, the code writes it exactly once to `TRANSFER_FROM_FROM_OFFSET`, then calls `transferFrom(from, CORE, amount)`.

Evidence:

- `contracts/src/locked/swap.huff`: one `transferFrom(address,address,uint256)` selector.
- `contracts/src/locked/swap.huff`: one `[TRANSFER_FROM_FROM_OFFSET] mstore`.
- `test_StaticTransferFromSurface`.

### Transfer branch preservation

If the loaded transfer-from word is zero, settlement uses `transfer(CORE, amount)` and does not call `transferFrom`. This preserves the intended delegatecall/transient-token behavior without expanding the `transferFrom` attack surface.

Evidence:

- `contracts/src/locked/swap.huff`: one `transfer(address,uint256)` selector.
- `contracts/src/locked/swap.huff`: `dup1 transferFromLbl jumpi` branches away from `transfer` only for nonzero `from`.
- `test_StaticTransferFromSurface`.

### Trailing calldata regression

The historical approval-drain class involved attacker-controlled trailing calldata being interpreted as the transfer-from address. The current regression test appends `attacker || 12 bytes || victim` and expects the successful settlement call to be:

```text
transferFrom(attacker, CORE, amount)
```

not `transferFrom(victim, CORE, amount)`.

Evidence:

- `test_TrailingCalldataCannotDrainVictimWhenAttackerAllowanceIsActive`
- `vm.expectCall(_ERC_20_FIRST_ADDRESS, abi.encodeCall(IERC20.transferFrom, (attacker, address(CORE), amount)))`

## Verification

Focused router tests:

```text
forge test --match-contract HuffRouterTest
Result: 13 passed, 0 failed, 0 skipped
```

Full contracts test suite:

```text
forge test
Result: 50 passed, 2 failed, 0 skipped
```

The full-suite failures are unrelated to the reviewed HuffRouter transfer settlement path:

- `VulnerableApprovalCancellerTest.setUp()` requires `MAINNET_RPC_URL_OR_ALIAS`.
- `VulnerableApprovalCancellerScriptTest.testFork_LoadRouterApprovals_RealIncidentJson()` requires `MAINNET_RPC_URL_OR_ALIAS`.

Static checks run during the audit:

```text
rg -n "tstore|tload|transfer\(address,uint256\)|transferFrom\(address,address,uint256\)|transferFromLbl|transferFromJoinLbl|\[TRANSFER_FROM_FROM_OFFSET\] mstore|caller .*transferFrom|\[WORD_SIZE\] calldatasize sub calldataload" contracts/src
git diff --check
```

The router source search showed:

- No `tstore` or `tload` in `contracts/src`.
- One `transfer(address,uint256)` selector in settlement.
- One `transferFrom(address,address,uint256)` selector in settlement.
- One write to `TRANSFER_FROM_FROM_OFFSET`.
- One caller append in `LOCK_SWAP_1`.
- One transfer-from read from the final callback calldata word.

## Assumptions

- Ekubo Core faithfully calls back into the router with the calldata supplied by `LOCK_SWAP`, as implemented by the reviewed Core lock flow.
- `CORE_CHECK()` remains the only path into locked settlement.
- ERC20 token behavior is outside this audit's scope. Non-standard or malicious ERC20 behavior may cause settlement failure or unusual token-level behavior, but does not change the reviewed router-side source of the `transferFrom.from` argument.
- Delegatecall users understand that `caller` resolves in the delegating execution context. In that mode, the `transfer` branch remains intentional for transiently held tokens.
- The static source-shape test is a regression guard, not a substitute for manual review of future structural rewrites.

## Conclusion

Within the reviewed scope and stated assumptions, this version of the HuffRouter transfer settlement code satisfies the audited invariant: the router can call `transferFrom` only through the single reviewed branch, and that branch uses the caller word appended by `LOCK_SWAP` as the `from` address. The `transfer` branch remains available and does not expand the `transferFrom` approval-spending surface.
