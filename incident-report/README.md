# Post-Mortem: `HuffRouter` Approval Draining via Trailing Calldata

A calldata parsing bug in `HuffRouter`, a gas-optimized Ekubo router contract written in Huff, allowed a caller to append arbitrary bytes after an otherwise valid swap route and have those bytes interpreted as router-set data during settlement.
This allowed attackers to cause the effective `transferFrom` address to be read from attacker-supplied trailing calldata, pointing it at a victim that had previously approved the router.

This issue affected both `HuffRouter` generations tied to Ekubo V2 and Ekubo V3 and led to approximately $1.43M in exploited funds:

- Mainnet V2: `0x8f52903d17e2d8d6c77d1a1de0cc975b6b5a0d15`
- Mainnet V2: `0x8ccb1ffd5c2aa6bd926473425dea4c8c15de60fd`
- Mainnet V3: `0x4f168f17923435c999f5c8565acab52c2218edf2`
- Arbitrum V3: `0xc93c4ad185ca48d66fefe80f906a67ef859fc47d`

## Exploit By Example

First seen in [0x770bc9a1f7c32cb63a5002b9ceb5c7994cd3af0fc6b2309cb32d3c46f629daa0](https://etherscan.io/tx/0x770bc9a1f7c32cb63a5002b9ceb5c7994cd3af0fc6b2309cb32d3c46f629daa0), the calldata initially passed to the `HuffRouter` started in the expected format:

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
01                : call type (unwrap)
```

The route contained only one hop and, in this example, it was not meant to execute successfully. That failure was not necessary for exploitation, but it was convenient because it avoided having to account for any real, dynamic deltas created by a successful hop execution such as a swap on a pool. Here, "deltas" means the net token amounts the router later tried to settle against Core.

The router attempted to call `Core.forward(to)` with WBTC as the `to` address. That call could only succeed when `to` was a contract that implemented the callback expected by Core forwarding. WBTC did not, so the forwarded call reverted.
Its success status was not checked. This was an intentional part of the router's design: any mismatch between the token movements tracked by the router and those tracked by Core would have caused Core to revert when the lock exited anyway, since Core requires debts to be zeroed at the end of the lock.

After all hops had been attempted to execute, the router tried to settle the accumulated deltas.
Because `specifiedTokenInfo` and `calculatedTokenInfo` both resolved to WBTC and the token contract was then treated as a `TokenWrapper` whose underlying token was also WBTC, the router needed to withdraw and pay 0.2 WBTC.

After the route description, the following malicious calldata was interpreted during settlement as if it had been set by the router itself:

```text
a911ff351b143634dbc5af3e204ea074583a83e3: recipient (attacker address)
b3ab4ab5ab6ab7ab8ab9ac0a                : 12-byte junk
765decf4fa157756e850c1079f60801b9219edd1: transferFrom (victim address)
9abcdef0...                             : trailing junk
```

The given `recipient` was no different from what the router would have intended, because with `withRecipient = false` the router would have defaulted the recipient to the caller, which in this exploit was the attacker. The injected `transferFrom` pointed to the victim's address.
Consequently, if the victim had approved the router, this allowed the attacker to use the victim's approval to transfer the router-tracked debt amount to Core, while previously withdrawing the same amount from Core to the attacker.

In the exploit transaction, the `HuffRouter` was called repeatedly with the same calldata, each time draining 0.2 WBTC from the victim.

## Root Cause

When calling `Core#lock`, the router passes along the original calldata, extended by some data used during settlement.
If `withRecipient = false`, it appends:

1. `msg.sender` as the default `recipient`, and then
2. `msg.sender` again as an ABI-encoded address used as `transferFrom`.

The vulnerability was in the parsing logic during settlement.
In the vulnerable version, ERC20 settlement loaded `transferFrom` and `recipient` from a relative offset based on the logical end of the decoded route.

That was unsafe because the parser's logical end of route data was not guaranteed to match the actual end of calldata. If a caller appended extra bytes after the logical route end, those bytes remained invisible to the route parser but still got picked up later during settlement.

As a result, attacker-controlled trailing bytes could be reinterpreted as:

- the recipient when `withRecipient = false`, and
- the `transferFrom` address.

While the `recipient` is intended to be caller-controllable, the `transferFrom` address should not be, which opened up the possibility for exploitation.

## Contributing Factors

We chose not to audit this contract because we assessed its practical risk as low. That assessment relied on two assumptions: approvals could be limited and bundled, and swaps initiated through the user interface would remain small and infrequent.

That judgment underestimated the consequences of a parsing bug in an approval-bearing router. Low expected usage and constrained approval patterns were not sufficient reasons to skip an audit of a contract that could move user funds.

In practice, approvals could be created through Ekubo user interface flows as well as direct wallet or contract interactions. The incident response therefore does not rely on assigning approval origin to affected users.

## Impact

The primary impact was approval draining from victims that had granted an affected router ERC20 approvals.

In the exploit pattern:

- the victim supplied the ERC20 allowance,
- the attacker supplied a crafted route, and
- the attacker received an arbitrary share of the victim's allowance.

In the example above, the attacker chose a route whose legitimate hop failed before creating meaningful dynamic deltas, but that was not a prerequisite for the bug.

Although the settlement flow in Ekubo V2 and V3 is different, the listed router deployments for both Ekubo versions were vulnerable because the flaw lived in the shared callback parsing logic.

## Analysis Artifacts

The analysis script used for assessing the impact of related exploits on mainnet is located at [`../sdk/scripts/incident-analysis.ts`](../sdk/scripts/incident-analysis.ts).

Arbitrum RPCs do not offer the required APIs for the analysis script.
Per manual inspection, we found [one successful exploit on Arbitrum](https://arbiscan.io/tx/0x2acce955281f53a2370031b15e455c073581e758453758cec56db7f7929ed35a) over 5 USDC.

The files in this directory are checked-in copies of the mainnet reports generated locally under `sdk/incident-analysis/`.

- [`incident-rows.csv`](./incident-rows.csv): one row per exploit incident
- [`summary-by-victim.json`](./summary-by-victim.json): victim-level loss summary
- [`summary-by-token.csv`](./summary-by-token.csv): token-level loss summary
- [`disqualified-victims.json`](./disqualified-victims.json): victims excluded due to later self-originated approval activity
- [`vulnerable-approvals.json`](./vulnerable-approvals.json): live vulnerable approvals grouped by router and token, including effective immediately drainable amounts
- [`vulnerable-approvals.csv`](./vulnerable-approvals.csv): flat list of remaining infinite approvals, token symbols, and the router contract that should be revoked

Anyone can reexecute the analysis from this repository with a mainnet RPC supporting the trace_* API:

```bash
cd ../sdk
npm i
MAINNET_RPC_URL=... npm run incident-analysis
```

The versions committed in this directory were copied from those runtime outputs for reference.

## Remediation

The fix was to stop deriving settlement data from route-relative offsets and instead anchor those reads to the actual end of calldata.

That change was applied in the places that previously trusted a route-relative offset to determine `transferFrom`.

This makes the callback consume the last router-appended bytes, rather than any bytes a caller smuggled in after the logical route end.

Regression tests were added to reproduce the exploit shape by appending `attacker || 12 bytes || victim` after the route.
One covers the case where the attacker is trying to spend only the victim's approval and asserts that the call fails.
Another covers the case where the attacker has a legitimate approval of their own and asserts that the call succeeds while the victim's funds remain untouched.

This prevents the behavior in patched or replacement deployments, but the affected deployed routers are immutable and remain vulnerable in place.

Alongside the contract-side fix, the Ekubo frontend immediately stopped offering separate approval flows for the affected routers so that new standalone approvals would not continue to accumulate while users migrated away from the vulnerable deployments.

## Operational Guidance

The affected deployments remain vulnerable because they are immutable and cannot be patched in place.

Infinite approvals to the affected `HuffRouter` deployments should be revoked immediately at [`revoke.cash`](https://revoke.cash/exploits/ekubo?chainId=1).
Non-infinite approvals were whitehatted out of the affected contracts, so the immediate revoke guidance is limited to infinite approvals.
Users are also encouraged to check [`vulnerable-approvals.csv`](./vulnerable-approvals.csv), the infinite approval artifact in this directory, to see which approvals remain exposed.

The Ekubo frontend was the only known dApp that created approvals for the various affected `HuffRouter` deployments.
When users who still have any outstanding approval visit the frontend, they are shown a banner that alerts them and encourages them to review it.

## Long-Term Mitigations

The specific parsing bug is fixed in the current repository, the frontend no longer generates separate approval calls for the affected routers, and users with outstanding approvals are warned in the interface.
The broader lesson is that systems built around ERC20 approvals should mitigate their exposure to inherently risky ERC20 approvals, and otherwise push toward safer approval standards.

In response, we opened [ERC-8255](https://eips.ethereum.org/EIPS/eip-8255), a draft standard for expiring token approvals.
The proposal makes approvals time-bounded so that they automatically become unusable after a limited duration, reducing the risk from stale approvals across tokens if adopted.

Separately, future router deployments will have an explicit expiration.
This limits the exposure created by stale approvals, even if users do not revoke them.
