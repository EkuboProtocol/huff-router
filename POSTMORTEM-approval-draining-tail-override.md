# Post-Mortem: `HyperRouter` Approval Draining via Trailing Calldata Override

## Summary

A calldata parsing bug in `HyperRouter` allowed a caller to append arbitrary bytes after an otherwise valid swap route and have those bytes interpreted as router-set data during settlement.
This allowed attackers to override the effective `transferFrom` address to the address of a victim that had previously approved the router.

This issue affects both `HyperRouter` generations tied to Ekubo V2 and Ekubo V3:

- Mainnet V2: `0x8f52903d17e2d8d6c77d1a1de0cc975b6b5a0d15`
- Mainnet V2: `0x8ccb1ffd5c2aa6bd926473425dea4c8c15de60fd`
- Mainnet V3: `0x4f168f17923435c999f5c8565acab52c2218edf2`
- Arbitrum V3: `0xc93c4ad185ca48d66fefe80f906a67ef859fc47d`

## Exploit By Example

First seen in [0x770bc9a1f7c32cb63a5002b9ceb5c7994cd3af0fc6b2309cb32d3c46f629daa0](https://etherscan.io/tx/0x770bc9a1f7c32cb63a5002b9ceb5c7994cd3af0fc6b2309cb32d3c46f629daa0), the calldata initially passed to the `HyperRouter` starts in the expected format:

```text
00                : withRecipient (false)
09                : specifiedAmountBytes (number of bytes of the specifiedAmount)
09                : calculatedAmountThresholdBytes (number of bytes of the calculatedAmountThreshold)
05                : specifiedTokenInfo (index of the WBTC address in an immutable token array)
05                : calculatedTokenInfo (as above)
00                : additionalMultiHops (0)
00                : withIntegrationFee (false)
00                : withSqrtRatio (false) | isExactOut (false)
000000000000d26163: calculatedAmountThreshold (13_787_491)
000000000001312d00: specifiedAmount (20_000_000)
00                : additionalHops (0)
05                : hop type (`TokenWrapper` hop)
01                : call type (whether to wrap or unwrap)
```

The route contains only one hop which is not meant to execute successfully. This failure is not necessary for exploitation, but it is convenient because it avoids having to account for any dynamic deltas created by a successful hop execution.

In this case, the router attempted to call `Core.forward(to)` with WBTC as the `to` address. That call can only succeed when `to` is a contract that implements the expected entrypoint `forwarded(uint256,address)`. WBTC does not, so the forwarded call simply reverts (which doesn't bubble up).

After all hops are executed (successfully or not), the router tries to settle the accumulated deltas.
Here, since WBTC is treated as a `TokenWrapper` contract and the underlying token of this imaginary `TokenWrapper` has the same address as the wrapper itself, the router has to both withdraw and pay 0.2 WBTC.

When calling `Core#lock`, the router appends the address of the caller to the passed calldata, to be used inside the lock for determining whose balance is used to settle the payment (named `transferFrom`).
Inside the lock though, it is assumed that `transferFrom` starts right after the end of the part of the calldata describing the route hops.

This can be exploited by passing malicious calldata after the route description, which, in the exploit transaction, was:

```text
a911ff351b143634dbc5af3e204ea074583a83e3: recipient (attacker address)
b3ab4ab5ab6ab7ab8ab9ac0a                : 12-byte junk
765decf4fa157756e850c1079f60801b9219edd1: transferFrom (victim address)
9abcdef0...                             : trailing junk
```

The given `recipient` is no different from what the router would have intended.
The attacker needs to pass it here though because, similar to `transferFrom`, it is appended to the calldata by the router before entering the lock and assumed to be present at a constant offset from the end of the route description.

The injected `transferFrom` points to the victim's address.
If the victim has approved the router, this allows the attacker to use the victim's approval to transfer the router-tracked debt amount to Core, while previously withdrawing the same amount from Core.

## Root Cause

The bug came from a mismatch between the two halves of the router:

- The entry path forwards the user-supplied route calldata unchanged and then appends router-set data after it.
- The callback path is responsible for recovering that router-set data during settlement.

The outer lock path behaved as intended. When `withRecipient = false`, it appends:

1. the recipient, and then
2. an ABI-encoded caller address used as `transferFrom`.

The vulnerability was in the settlement callback.
In the vulnerable version, ERC20 settlement loaded `transferFrom` and `recipient` from a relative offset based from the logical end of the decoded route.

That was unsafe because the parser's logical end of route data was not guaranteed to match the actual end of calldata. If a caller appended extra bytes after the logical route end, those bytes remained invisible to the parser but still got picked up later by payment or refund handling.

As a result, attacker-controlled trailing bytes could be reinterpreted as:

- the recipient when `withRecipient = false`, and
- the `transferFrom` address or refund recipient in the affected payment paths.

## Impact

The primary impact was approval draining from victims that had granted an affected router ERC20 approvals.

In the exploit pattern above:

- the attacker supplied a crafted route that reached the wrapped-token payment path,
- the victim supplied the ERC20 allowance, and
- the attacker received the output.

Altough the settlement flow in Ekubo V2 and V3 is different, the listed router deployments for both Ekubo versions are vulnerable since the flaw lives in the shared callback parsing logic.

## Remediation

The fix was to stop deriving router-set data from parser-relative offsets and instead anchor those reads to the actual end of calldata.

That change was applied in both places that previously trusted a route-relative offset:

- `transferFrom`
- `recipient`

This makes the callback consume the last router-appended bytes, rather than any bytes a caller smuggled in after the logical route end.

A regression test was also added to reproduce the exploit shape by appending `attacker || 12 bytes || victim` and to assert that the call fails without changing the victim's wrapped-token balance or the attacker's received underlying balance.
