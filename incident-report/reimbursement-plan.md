# Reimbursement Plan

> **Disclaimer:** This entire reimbursement plan is pending legal review. It is tentative, subject to change, and may or may not be adopted, approved, funded, or implemented in whole or in part.

This proposed plan uses the checked-in incident analysis artifacts and applies a single general reimbursement cap per affected address. The exact per-address cap is **TBD**.

If pursued, this reimbursement plan would require DAO approval to fund it before any reimbursement distribution could proceed.

Reimbursements are intended to be made **in kind**, in the affected token. USD values use the current Ethereum token prices returned by the Ekubo token API at the time this plan was prepared on May 12, 2026, and are included to document the USD value of the affected token amounts and apply the TBD per-address cap.

The cap applies regardless of approval size or approval origin. Some approvals may have been created through Ekubo user interface flows, so this plan does not classify affected users by whether an exploited approval was a maximum approval.

## Capped Reimbursement

The identified reimbursement input currently contains:

- `31` reimbursement addresses
- `34` address-token reimbursement rows
- approximately `$1,419,543.08` of identified affected token value at the USD marks used below
- planned reimbursement value TBD after applying the final per-address cap

When an address has losses in multiple affected tokens and the TBD cap is lower than the address's total identified loss, in-kind reimbursement will be allocated starting with the largest affected token balance by USD value, then the next largest, until the cap is reached.

For example, if one affected token balance saturates the cap, reimbursement will be only in that token. If the two largest of three affected token balances saturate the cap, reimbursement will be only in those two tokens.

The largest affected address currently has:

- `17.01484735` WBTC, worth approximately `$1,368,067.51`
- `0.34386474` cbBTC, worth approximately `$27,715.42`

Because WBTC is the larger affected token balance for that address, in-kind reimbursement for that address will start with WBTC. If the final cap is saturated by WBTC, reimbursement will be only in WBTC. If the final cap exceeds the WBTC reimbursement amount, the remaining cap capacity will next apply to cbBTC.

The standalone machine-readable identified-loss input is [`reimbursement-losses.csv`](./reimbursement-losses.csv).

## Conditions

For reimbursement, Ekubo, Inc. will handle:

- reimbursement distribution
- collection of KYC documents as needed
- collection of executed releases of claims for the DAO, tokenholders, and Ekubo, Inc. as needed
- verification that any remaining infinite affected approval has been revoked before payment

Individual reimbursement is at Ekubo, Inc.'s discretion and may be subject to:

- KYC completion, as needed
- execution of a release of claims in favor of the DAO, tokenholders, and Ekubo, Inc., as needed
- revocation of any remaining infinite affected approval before reimbursement
- reimbursement only to the same affected address

Users with infinite approvals to affected router contracts should immediately revoke them using [`revoke.cash`](https://revoke.cash/exploits/ekubo?chainId=1). Non-infinite approvals were whitehatted out of the affected contracts, so the revoke advice is limited to infinite approvals.
