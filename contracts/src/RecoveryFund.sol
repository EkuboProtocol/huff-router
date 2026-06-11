// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {EIP712} from "solady/utils/EIP712.sol";
import {Multicallable} from "solady/utils/Multicallable.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {SignatureCheckerLib} from "solady/utils/SignatureCheckerLib.sol";

contract RecoveryFund is EIP712, Multicallable {
    struct Claim {
        address claimant;
        address token;
        uint256 amount;
    }

    string internal constant DOMAIN_NAME = "Recovery Fund";
    string internal constant DOMAIN_VERSION = "1";

    /// @notice Type hash for agreeing to the claim conditions.
    bytes32 public constant AGREE_TO_CLAIM_CONDITIONS_TYPEHASH =
        keccak256("AgreeToClaimConditions(string claimConditions)");

    /// @notice Hash of the claim conditions included in every signed claim.
    bytes32 public immutable messageHash;

    /// @notice EIP-712 struct hash for claim-conditions agreement.
    bytes32 public immutable claimConditionsStructHash;

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

    /// @notice Emitted when a claimant and token allocation is recorded.
    /// @param claimant Address whose claimable balance was allocated.
    /// @param token ERC20 token address, or `address(0)` for native ETH.
    /// @param amount Amount allocated to the claimant.
    event RecoveryAllocated(address indexed claimant, address indexed token, uint256 amount);

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

    /// @notice Thrown when the refund address is zero.
    error InvalidRefundAddress();

    /// @notice Thrown when the refund timestamp is not strictly in the future.
    error InvalidRefundTimestamp();

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
    /// @param claims Claimant, token, and amount allocations recorded at deployment.
    /// @param refundAddress_ Address that receives unclaimed funds after `refundTimestamp_`.
    /// @param refundTimestamp_ Timestamp after which unclaimed funds can be refunded.
    constructor(string memory claimConditions, Claim[] memory claims, address refundAddress_, uint256 refundTimestamp_)
        payable {
        if (refundAddress_ == address(0)) revert InvalidRefundAddress();
        if (refundTimestamp_ <= block.timestamp) revert InvalidRefundTimestamp();

        messageHash = keccak256(bytes(claimConditions));
        refundAddress = refundAddress_;
        refundTimestamp = refundTimestamp_;
        claimConditionsStructHash = keccak256(abi.encode(AGREE_TO_CLAIM_CONDITIONS_TYPEHASH, messageHash));
        emit ClaimConditions(messageHash, claimConditions);

        for (uint256 i = 0; i < claims.length; i++) {
            if (claims[i].claimant == address(0)) revert InvalidClaimant();
            if (claims[i].amount == 0) revert InvalidAmount();

            recoveryAmount[claims[i].claimant][claims[i].token] += claims[i].amount;
            emit RecoveryAllocated(claims[i].claimant, claims[i].token, claims[i].amount);
        }
    }

    /// @notice Receives native ETH used to back native recovery claims.
    receive() external payable {}

    /// @notice Records that a claimant has accepted the claim conditions.
    /// @dev Any caller may submit the claimant's signature. The signature only authorizes the
    /// constructor-derived `messageHash`; it does not bind the token, amount, recipient, or caller.
    /// @param claimant Address whose signature is checked.
    /// @param signature Claimant signature over the EIP-712 claim-conditions digest.
    function agreeToClaimConditions(address claimant, bytes calldata signature) external {
        if (claimant == address(0)) revert InvalidClaimant();

        if (!SignatureCheckerLib.isValidSignatureNowCalldata(
                claimant, _hashTypedData(claimConditionsStructHash), signature
            )) {
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

    /// @notice Returns the current EIP-712 digest claimants must sign to accept claim conditions.
    /// @return digest Current claim-conditions digest for this domain separator.
    function claimConditionsDigest() external view returns (bytes32 digest) {
        digest = _hashTypedData(claimConditionsStructHash);
    }

    function _domainNameAndVersion() internal pure override returns (string memory name, string memory version) {
        name = DOMAIN_NAME;
        version = DOMAIN_VERSION;
    }
}
