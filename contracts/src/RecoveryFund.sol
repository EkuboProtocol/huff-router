// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {EIP712} from "solady/utils/EIP712.sol";
import {Multicallable} from "solady/utils/Multicallable.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {SignatureCheckerLib} from "solady/utils/SignatureCheckerLib.sol";

contract RecoveryFund is EIP712, Multicallable {
    string internal constant DOMAIN_NAME = "Recovery Fund";
    string internal constant DOMAIN_VERSION = "1";

    /// @notice Type hash for agreeing to the claim conditions.
    bytes32 public constant AGREE_TO_CLAIM_CONDITIONS_TYPEHASH =
        keccak256("AgreeToClaimConditions(string claimConditions)");

    /// @notice Hash of the claim conditions included in every signed claim.
    bytes32 public immutable messageHash;

    /// @notice EIP-712 digest claimants must sign to accept the claim conditions.
    bytes32 public immutable claimConditionsDigest;

    /// @notice Address that receives unclaimed funds after `refundTimestamp`.
    address public immutable refundAddress;

    /// @notice Timestamp after which remaining funds can be refunded.
    uint256 public immutable refundTimestamp;

    /// @notice Claimable recovery amount for each claimant and token.
    mapping(address claimant => mapping(address token => uint256 amount)) public recoveryAmount;

    /// @notice Whether a claimant has ever submitted a valid signature for the claim conditions.
    mapping(address claimant => bool signed) public hasSignedClaimConditions;

    /// @notice Emitted once at deployment with the human-readable claim conditions.
    /// @param messageHash Hash of the emitted claim conditions.
    /// @param claimConditions Human-readable conditions claimants must sign.
    event ClaimConditions(bytes32 indexed messageHash, string claimConditions);

    /// @notice Emitted the first time a claimant submits a valid claim-conditions signature.
    /// @param claimant Address that signed the claim conditions.
    /// @param signature Signature submitted for the claim conditions.
    event ClaimConditionsSigned(address indexed claimant, bytes signature);

    /// @notice Emitted when recovery funds are added for a claimant and token.
    /// @param funder Address that supplied the funds.
    /// @param claimant Address whose claimable balance increased.
    /// @param token ERC20 token address, or `address(0)` for native ETH.
    /// @param amount Amount credited to the claimant.
    event RecoveryFunded(address indexed funder, address indexed claimant, address indexed token, uint256 amount);

    /// @notice Emitted when funded recovery assets are claimed.
    /// @param claimant Address whose claimable balance was reduced.
    /// @param recipient Address that received the claimed assets.
    /// @param token ERC20 token address, or `address(0)` for native ETH.
    /// @param amount Amount claimed.
    event RecoveryClaimed(address indexed claimant, address indexed recipient, address indexed token, uint256 amount);

    /// @notice Emitted when unclaimed assets are refunded after the claim period.
    /// @param caller Address that triggered the refund.
    /// @param token ERC20 token address, or `address(0)` for native ETH.
    /// @param amount Amount refunded to `refundAddress`.
    event RecoveryRefunded(address indexed caller, address indexed token, uint256 amount);

    /// @notice Thrown when the claimant address is zero.
    error InvalidClaimant();

    /// @notice Thrown when a fund, claim, or refund amount is zero.
    error InvalidAmount();

    /// @notice Thrown when `msg.value` does not match the funding token mode.
    error InvalidFundingValue();

    /// @notice Thrown when the refund address is zero.
    error InvalidRefundAddress();

    /// @notice Thrown when a claimant does not have enough funded balance for a token.
    error InsufficientRecoveryAmount();

    /// @notice Thrown when a claim is attempted before the claimant has agreed to the claim conditions.
    error ClaimConditionsNotSigned();

    /// @notice Thrown when the submitted signature is not valid for the claimant.
    error InvalidSignature();

    /// @notice Thrown when a refund is attempted before the refund timestamp.
    error RefundNotAvailable();

    /// @notice Creates a recovery contract for a fixed set of claim conditions.
    /// @param claimConditions Human-readable conditions that are hashed into every claim.
    /// @param refundAddress_ Address that receives unclaimed funds after `refundTimestamp_`.
    /// @param refundTimestamp_ Timestamp after which unclaimed funds can be refunded.
    constructor(string memory claimConditions, address refundAddress_, uint256 refundTimestamp_) {
        if (refundAddress_ == address(0)) revert InvalidRefundAddress();

        messageHash = keccak256(bytes(claimConditions));
        refundAddress = refundAddress_;
        refundTimestamp = refundTimestamp_;
        bytes32 separator = keccak256(
            abi.encode(
                _DOMAIN_TYPEHASH,
                keccak256(bytes(DOMAIN_NAME)),
                keccak256(bytes(DOMAIN_VERSION)),
                block.chainid,
                address(this)
            )
        );
        bytes32 structHash = keccak256(abi.encode(AGREE_TO_CLAIM_CONDITIONS_TYPEHASH, messageHash));
        claimConditionsDigest = keccak256(abi.encodePacked("\x19\x01", separator, structHash));
        emit ClaimConditions(messageHash, claimConditions);
    }

    /// @notice Adds recovery funds for a claimant and token.
    /// @dev Use `address(0)` as `token` to fund native ETH.
    /// @param claimant Address that will be allowed to claim these funds.
    /// @param token ERC20 token address, or `address(0)` for native ETH.
    /// @param amount Amount to fund, or exact `msg.value` for native ETH.
    function fund(address claimant, address token, uint256 amount) external payable {
        if (claimant == address(0)) revert InvalidClaimant();
        if (amount == 0) revert InvalidAmount();

        if (token == address(0)) {
            if (msg.value != amount) revert InvalidFundingValue();
        } else {
            if (msg.value != 0) revert InvalidFundingValue();
            SafeTransferLib.safeTransferFrom(token, msg.sender, address(this), amount);
        }

        recoveryAmount[claimant][token] += amount;

        emit RecoveryFunded(msg.sender, claimant, token, amount);
    }

    /// @notice Records that a claimant has accepted the claim conditions.
    /// @dev Any caller may submit the claimant's signature. The signature only authorizes the
    /// constructor-derived `messageHash`; it does not bind the token, amount, recipient, or caller.
    /// @param claimant Address whose signature is checked.
    /// @param signature Claimant signature over the EIP-712 claim-conditions digest.
    function agreeToClaimConditions(address claimant, bytes calldata signature) external {
        if (claimant == address(0)) revert InvalidClaimant();

        if (!SignatureCheckerLib.isValidSignatureNowCalldata(claimant, claimConditionsDigest, signature)) {
            revert InvalidSignature();
        }

        if (!hasSignedClaimConditions[claimant]) {
            hasSignedClaimConditions[claimant] = true;
            emit ClaimConditionsSigned(claimant, signature);
        }
    }

    /// @notice Claims recovery funds after the claimant has agreed to the claim conditions.
    /// @dev Agreement does not bind the token, amount, or recipient. The claimant is always
    /// `msg.sender`.
    /// @param recipient Address receiving the recovery funds.
    /// @param token ERC20 token address, or `address(0)` for native ETH.
    /// @param amount Amount to claim.
    function claim(address recipient, address token, uint256 amount) external {
        if (amount == 0) revert InvalidAmount();
        if (!hasSignedClaimConditions[msg.sender]) revert ClaimConditionsNotSigned();

        uint256 available = recoveryAmount[msg.sender][token];
        if (available < amount) revert InsufficientRecoveryAmount();

        recoveryAmount[msg.sender][token] = available - amount;

        if (token == address(0)) {
            SafeTransferLib.safeTransferETH(recipient, amount);
        } else {
            SafeTransferLib.safeTransfer(token, recipient, amount);
        }

        emit RecoveryClaimed(msg.sender, recipient, token, amount);
    }

    /// @notice Sends all remaining balance for a token to `refundAddress` after the claim period.
    /// @dev Use `address(0)` as `token` to refund native ETH.
    /// @param token ERC20 token address, or `address(0)` for native ETH.
    function refund(address token) external {
        if (block.timestamp < refundTimestamp) revert RefundNotAvailable();

        uint256 amount;
        if (token == address(0)) {
            amount = address(this).balance;
            if (amount == 0) revert InvalidAmount();
            SafeTransferLib.safeTransferETH(refundAddress, amount);
        } else {
            amount = SafeTransferLib.balanceOf(token, address(this));
            if (amount == 0) revert InvalidAmount();
            SafeTransferLib.safeTransfer(token, refundAddress, amount);
        }

        emit RecoveryRefunded(msg.sender, token, amount);
    }

    /// @notice Returns the EIP-712 domain separator used for claim signatures.
    /// @return separator Current domain separator.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparator();
    }

    function _domainNameAndVersion() internal pure override returns (string memory name, string memory version) {
        name = DOMAIN_NAME;
        version = DOMAIN_VERSION;
    }
}
