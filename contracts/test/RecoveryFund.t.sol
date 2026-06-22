// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {RecoveryFund} from "../src/RecoveryFund.sol";

import {Test} from "forge-std/Test.sol";
import {Ownable} from "solady/auth/Ownable.sol";
import {ERC20} from "solady/tokens/ERC20.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

contract RecoveryToken is ERC20 {
    function name() public pure override returns (string memory) {
        return "Recovery Token";
    }

    function symbol() public pure override returns (string memory) {
        return "RCV";
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract RecoveryFundTest is Test {
    uint256 private constant CLAIMANT_PRIVATE_KEY = 0xA11CE;
    uint256 private constant OTHER_PRIVATE_KEY = 0xB0B;

    string private constant CLAIM_CONDITIONS =
        "I release and hold harmless the DAO, tokenholders, and company for the recovery event.";

    RecoveryFund private recovery;
    RecoveryToken private token;
    address private claimant;
    address private recipient = address(0xCAFE);
    address private owner = address(0x1234);
    address private funder = address(0xF00D);
    address private thief = address(0xBAD);

    function setUp() public {
        claimant = vm.addr(CLAIMANT_PRIVATE_KEY);
        vm.expectEmit(true, true, false, true);
        emit Ownable.OwnershipTransferred(address(0), owner);
        vm.expectEmit(true, false, false, true);
        emit RecoveryFund.ClaimConditions(keccak256(bytes(CLAIM_CONDITIONS)), CLAIM_CONDITIONS);
        recovery = new RecoveryFund(CLAIM_CONDITIONS, _emptyClaims(), owner);
        token = new RecoveryToken();

        token.mint(funder, 1_000 ether);
        vm.deal(funder, 100 ether);
    }

    function test_ConstructorStoresClaimConditionsHash() external view {
        assertEq(recovery.messageHash(), keccak256(bytes(CLAIM_CONDITIONS)));
        assertEq(recovery.domainSeparator(), _domainSeparator());
        assertEq(recovery.claimConditionsDigest(), _claimConditionsDigest());
        assertEq(recovery.owner(), owner);
        assertFalse(recovery.claimsEnded());
    }

    function test_ConstructorAllowsZeroOwnerForPermanentClaims() external {
        recovery = new RecoveryFund(CLAIM_CONDITIONS, _singleClaim(claimant, address(token), 100 ether), address(0));
        assertEq(recovery.owner(), address(0));
        assertFalse(recovery.claimsEnded());

        vm.prank(funder);
        assertTrue(token.transfer(address(recovery), 100 ether));

        bytes memory signature = _signClaim(CLAIMANT_PRIVATE_KEY);
        vm.startPrank(claimant);
        recovery.agreeToClaimConditions(claimant, signature);
        recovery.claim(recipient, address(token), 40 ether);
        vm.stopPrank();

        assertEq(recovery.recoveryAmount(claimant, address(token)), 60 ether);
        assertEq(token.balanceOf(recipient), 40 ether);

        vm.expectRevert(Ownable.Unauthorized.selector);
        recovery.endClaims();

        vm.expectRevert(RecoveryFund.ClaimsNotEnded.selector);
        recovery.refund(address(token));
    }

    function testRevert_ConstructorWithZeroClaimant() external {
        vm.expectRevert(RecoveryFund.InvalidClaimant.selector);
        new RecoveryFund(CLAIM_CONDITIONS, _singleClaim(address(0), address(token), 100 ether), owner);
    }

    function testRevert_ConstructorWithZeroAmount() external {
        vm.expectRevert(RecoveryFund.InvalidAmount.selector);
        new RecoveryFund(CLAIM_CONDITIONS, _singleClaim(claimant, address(token), 0), owner);
    }

    function test_Eip712ClaimConditionsUsePlaintextStringField() external {
        bytes32 stringTypeHash = keccak256("AgreeToClaimConditions(string claimConditions)");
        bytes32 bytes32TypeHash = keccak256("ClaimConditions(bytes32 messageHash)");

        assertEq(recovery.AGREE_TO_CLAIM_CONDITIONS_TYPEHASH(), stringTypeHash);
        assertNotEq(recovery.AGREE_TO_CLAIM_CONDITIONS_TYPEHASH(), bytes32TypeHash);

        bytes32 structHash = keccak256(abi.encode(stringTypeHash, keccak256(bytes(CLAIM_CONDITIONS))));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", recovery.domainSeparator(), structHash));

        assertEq(recovery.messageHash(), keccak256(bytes(CLAIM_CONDITIONS)));
        assertEq(recovery.claimConditionsDigest(), digest);

        vm.expectEmit(true, false, false, true);
        emit RecoveryFund.ClaimConditions(keccak256(bytes(CLAIM_CONDITIONS)), CLAIM_CONDITIONS);
        vm.expectEmit(true, true, false, true);
        emit RecoveryFund.RecoveryAllocated(claimant, address(token), 100 ether);
        RecoveryFund allocated = _deployRecovery(_singleClaim(claimant, address(token), 100 ether));
        assertEq(allocated.recoveryAmount(claimant, address(token)), 100 ether);
        assertEq(token.balanceOf(address(allocated)), 0);
    }

    function test_ConstructorAllocatesNativeClaim() external {
        RecoveryFund allocated = _deployRecovery(_singleClaim(claimant, address(0), 1 ether));

        assertEq(allocated.recoveryAmount(claimant, address(0)), 1 ether);
        assertEq(address(allocated).balance, 0);
    }

    function test_ClaimErc20WithValidSignature() external {
        _fundToken(100 ether);

        bytes memory signature = _signClaim(CLAIMANT_PRIVATE_KEY);

        vm.expectEmit(true, false, false, true, address(recovery));
        emit RecoveryFund.ClaimConditionsSigned(claimant, signature);
        recovery.agreeToClaimConditions(claimant, signature);

        vm.expectEmit(true, true, true, true, address(recovery));
        emit RecoveryFund.RecoveryClaimed(claimant, recipient, address(token), 40 ether);
        vm.prank(claimant);
        recovery.claim(recipient, address(token), 40 ether);

        assertEq(recovery.recoveryAmount(claimant, address(token)), 60 ether);
        assertTrue(recovery.hasSignedClaimConditions(claimant));
        assertEq(token.balanceOf(recipient), 40 ether);
    }

    function test_RelayerCanSubmitAgreementForClaimant() external {
        bytes memory signature = _signClaim(CLAIMANT_PRIVATE_KEY);

        recovery.agreeToClaimConditions(claimant, signature);

        assertTrue(recovery.hasSignedClaimConditions(claimant));
    }

    function testRevert_RelayerAgreementDoesNotAuthorizeRelayerToClaim() external {
        _fundToken(100 ether);

        bytes memory signature = _signClaim(CLAIMANT_PRIVATE_KEY);
        vm.prank(thief);
        recovery.agreeToClaimConditions(claimant, signature);

        vm.expectRevert(RecoveryFund.ClaimConditionsNotSigned.selector);
        vm.prank(thief);
        recovery.claim(thief, address(token), 40 ether);

        assertEq(recovery.recoveryAmount(claimant, address(token)), 100 ether);
        assertEq(token.balanceOf(thief), 0);
    }

    function test_MulticallAgreeAndClaimErc20() external {
        _fundToken(100 ether);

        bytes memory signature = _signClaim(CLAIMANT_PRIVATE_KEY);

        bytes[] memory data = new bytes[](2);
        data[0] = abi.encodeCall(RecoveryFund.agreeToClaimConditions, (claimant, signature));
        data[1] = abi.encodeCall(RecoveryFund.claim, (recipient, address(token), 40 ether));

        vm.startPrank(claimant);
        bytes[] memory results = recovery.multicall(data);
        vm.stopPrank();

        assertEq(results.length, 2);
        assertEq(results[0].length, 0);
        assertEq(results[1].length, 0);
        assertEq(recovery.recoveryAmount(claimant, address(token)), 60 ether);
        assertEq(token.balanceOf(recipient), 40 ether);
    }

    function testRevert_MulticallRelayerCannotAgreeForClaimantAndClaim() external {
        _fundToken(100 ether);

        bytes memory signature = _signClaim(CLAIMANT_PRIVATE_KEY);

        bytes[] memory data = new bytes[](2);
        data[0] = abi.encodeCall(RecoveryFund.agreeToClaimConditions, (claimant, signature));
        data[1] = abi.encodeCall(RecoveryFund.claim, (thief, address(token), 40 ether));

        vm.expectRevert(RecoveryFund.ClaimConditionsNotSigned.selector);
        vm.prank(thief);
        recovery.multicall(data);

        assertEq(recovery.recoveryAmount(claimant, address(token)), 100 ether);
        assertEq(token.balanceOf(thief), 0);
    }

    function test_ClaimNativeWithValidSignature() external {
        _fundNative(1 ether);

        bytes memory signature = _signClaim(CLAIMANT_PRIVATE_KEY);
        vm.startPrank(claimant);
        recovery.agreeToClaimConditions(claimant, signature);

        uint256 balanceBefore = recipient.balance;
        recovery.claim(recipient, address(0), 1 ether);
        vm.stopPrank();

        assertEq(recovery.recoveryAmount(claimant, address(0)), 0);
        assertEq(recipient.balance - balanceBefore, 1 ether);
    }

    function testRevert_ClaimWithWrongSigner() external {
        _fundToken(100 ether);

        bytes memory signature = _signClaim(OTHER_PRIVATE_KEY);

        vm.expectRevert(RecoveryFund.InvalidSignature.selector);
        recovery.agreeToClaimConditions(claimant, signature);
    }

    function testRevert_ClaimWithZeroAmount() external {
        vm.expectRevert(RecoveryFund.InvalidAmount.selector);
        vm.prank(claimant);
        recovery.claim(recipient, address(token), 0);
    }

    function testRevert_ClaimWithoutAgreement() external {
        _fundToken(100 ether);

        vm.expectRevert(RecoveryFund.ClaimConditionsNotSigned.selector);
        vm.prank(claimant);
        recovery.claim(recipient, address(token), 40 ether);
    }

    function testRevert_UnsignedCallerCannotClaim() external {
        _fundToken(100 ether);

        bytes memory signature = _signClaim(CLAIMANT_PRIVATE_KEY);
        recovery.agreeToClaimConditions(claimant, signature);

        vm.expectRevert(RecoveryFund.ClaimConditionsNotSigned.selector);
        recovery.claim(recipient, address(token), 40 ether);

        assertEq(recovery.recoveryAmount(claimant, address(token)), 100 ether);
        assertEq(token.balanceOf(recipient), 0);
    }

    function testRevert_SignedCallerCannotStealAnotherClaimantsFunds() external {
        _fundToken(100 ether);

        bytes memory claimantSignature = _signClaim(CLAIMANT_PRIVATE_KEY);
        bytes memory thiefSignature = _signClaim(OTHER_PRIVATE_KEY);
        recovery.agreeToClaimConditions(claimant, claimantSignature);
        recovery.agreeToClaimConditions(vm.addr(OTHER_PRIVATE_KEY), thiefSignature);

        vm.expectRevert(RecoveryFund.InsufficientRecoveryAmount.selector);
        vm.prank(vm.addr(OTHER_PRIVATE_KEY));
        recovery.claim(thief, address(token), 100 ether);

        assertEq(recovery.recoveryAmount(claimant, address(token)), 100 ether);
        assertEq(token.balanceOf(thief), 0);
        assertEq(token.balanceOf(address(recovery)), 100 ether);
    }

    function test_ClaimSignatureAllowsAnyFundedAmountAndRecipient() external {
        _fundToken(100 ether);

        bytes memory signature = _signClaim(CLAIMANT_PRIVATE_KEY);
        address secondRecipient = address(0xBEEF);

        vm.startPrank(claimant);
        recovery.agreeToClaimConditions(claimant, signature);
        recovery.claim(recipient, address(token), 25 ether);
        recovery.claim(secondRecipient, address(token), 30 ether);
        vm.stopPrank();

        assertEq(recovery.recoveryAmount(claimant, address(token)), 45 ether);
        assertEq(token.balanceOf(recipient), 25 ether);
        assertEq(token.balanceOf(secondRecipient), 30 ether);
    }

    function test_ClaimSameSignatureForMultipleClaims() external {
        _fundToken(80 ether);

        bytes memory signature = _signClaim(CLAIMANT_PRIVATE_KEY);
        vm.startPrank(claimant);
        recovery.agreeToClaimConditions(claimant, signature);

        recovery.claim(recipient, address(token), 40 ether);
        recovery.claim(recipient, address(token), 40 ether);
        vm.stopPrank();

        assertEq(recovery.recoveryAmount(claimant, address(token)), 0);
        assertEq(token.balanceOf(recipient), 80 ether);
    }

    function testRevert_ClaimMoreThanAllocated() external {
        _fundToken(39 ether);

        bytes memory signature = _signClaim(CLAIMANT_PRIVATE_KEY);
        recovery.agreeToClaimConditions(claimant, signature);

        vm.expectRevert(RecoveryFund.InsufficientRecoveryAmount.selector);
        vm.prank(claimant);
        recovery.claim(recipient, address(token), 40 ether);
    }

    function testRevert_ClaimErc20WhenContractNotFunded() external {
        _allocateToken(100 ether);

        bytes memory signature = _signClaim(CLAIMANT_PRIVATE_KEY);
        recovery.agreeToClaimConditions(claimant, signature);

        vm.expectRevert(SafeTransferLib.TransferFailed.selector);
        vm.prank(claimant);
        recovery.claim(recipient, address(token), 40 ether);

        assertEq(recovery.recoveryAmount(claimant, address(token)), 100 ether);
        assertEq(token.balanceOf(recipient), 0);
    }

    function testRevert_ClaimNativeWhenContractNotFunded() external {
        _allocateNative(1 ether);

        bytes memory signature = _signClaim(CLAIMANT_PRIVATE_KEY);
        recovery.agreeToClaimConditions(claimant, signature);

        vm.expectRevert(SafeTransferLib.ETHTransferFailed.selector);
        vm.prank(claimant);
        recovery.claim(recipient, address(0), 1 ether);

        assertEq(recovery.recoveryAmount(claimant, address(0)), 1 ether);
        assertEq(recipient.balance, 0);
    }

    function test_EndClaimsByOwner() external {
        vm.expectEmit(true, false, false, true, address(recovery));
        emit RecoveryFund.ClaimsEnded();
        vm.prank(owner);
        recovery.endClaims();

        assertTrue(recovery.claimsEnded());
    }

    function testRevert_NonOwnerCannotTransferOwnership() external {
        vm.expectRevert(Ownable.Unauthorized.selector);
        vm.prank(thief);
        recovery.transferOwnership(thief);

        assertEq(recovery.owner(), owner);
    }

    function testRevert_AttackerCannotCompleteOwnOwnershipHandover() external {
        vm.prank(thief);
        recovery.requestOwnershipHandover();

        vm.expectRevert(Ownable.Unauthorized.selector);
        vm.prank(thief);
        recovery.completeOwnershipHandover(thief);

        assertEq(recovery.owner(), owner);
    }

    function test_OwnerCanTransferOwnershipAndNewOwnerControlsClaimsEnd() external {
        _fundToken(100 ether);

        address newOwner = address(0x5678);
        vm.prank(owner);
        recovery.transferOwnership(newOwner);

        assertEq(recovery.owner(), newOwner);

        vm.expectRevert(Ownable.Unauthorized.selector);
        vm.prank(owner);
        recovery.endClaims();

        vm.prank(newOwner);
        recovery.endClaims();

        vm.prank(thief);
        recovery.refund(address(token));

        assertEq(token.balanceOf(newOwner), 100 ether);
        assertEq(token.balanceOf(owner), 0);
        assertEq(token.balanceOf(thief), 0);
    }

    function testRevert_EndClaimsByNonOwner() external {
        vm.expectRevert(Ownable.Unauthorized.selector);
        recovery.endClaims();
    }

    function testRevert_EndClaimsTwice() external {
        vm.prank(owner);
        recovery.endClaims();

        vm.expectRevert(RecoveryFund.ClaimsAreEnded.selector);
        vm.prank(owner);
        recovery.endClaims();
    }

    function test_RefundErc20AfterClaimsEnded() external {
        _fundToken(100 ether);
        vm.prank(owner);
        recovery.endClaims();

        vm.expectEmit(true, true, false, true, address(recovery));
        emit RecoveryFund.RecoveryRefunded(address(this), address(token), 100 ether);
        recovery.refund(address(token));

        assertEq(token.balanceOf(owner), 100 ether);
        assertEq(token.balanceOf(address(recovery)), 0);
    }

    function test_RefundErc20CannotBeStolenByCaller() external {
        _fundToken(100 ether);
        vm.prank(owner);
        recovery.endClaims();

        vm.prank(thief);
        recovery.refund(address(token));

        assertEq(token.balanceOf(owner), 100 ether);
        assertEq(token.balanceOf(thief), 0);
        assertEq(token.balanceOf(address(recovery)), 0);
    }

    function test_RefundNativeAfterClaimsEnded() external {
        _fundNative(1 ether);
        vm.prank(owner);
        recovery.endClaims();

        uint256 balanceBefore = owner.balance;
        recovery.refund(address(0));

        assertEq(owner.balance - balanceBefore, 1 ether);
        assertEq(address(recovery).balance, 0);
    }

    function test_RefundNativeCannotBeStolenByCaller() external {
        _fundNative(1 ether);
        vm.prank(owner);
        recovery.endClaims();

        uint256 refundBalanceBefore = owner.balance;
        uint256 thiefBalanceBefore = thief.balance;

        vm.prank(thief);
        recovery.refund(address(0));

        assertEq(owner.balance - refundBalanceBefore, 1 ether);
        assertEq(thief.balance, thiefBalanceBefore);
        assertEq(address(recovery).balance, 0);
    }

    function testRevert_RefundBeforeClaimsEnded() external {
        _fundToken(100 ether);

        vm.expectRevert(RecoveryFund.ClaimsNotEnded.selector);
        recovery.refund(address(token));
    }

    function testRevert_ClaimErc20AfterClaimsEnded() external {
        _fundToken(100 ether);

        bytes memory signature = _signClaim(CLAIMANT_PRIVATE_KEY);
        recovery.agreeToClaimConditions(claimant, signature);

        vm.prank(owner);
        recovery.endClaims();
        recovery.refund(address(token));

        vm.expectRevert(RecoveryFund.ClaimsAreEnded.selector);
        vm.prank(claimant);
        recovery.claim(recipient, address(token), 40 ether);

        assertEq(recovery.recoveryAmount(claimant, address(token)), 100 ether);
        assertEq(token.balanceOf(owner), 100 ether);
        assertEq(token.balanceOf(address(recovery)), 0);
        assertEq(token.balanceOf(recipient), 0);
    }

    function testRevert_ClaimNativeAfterClaimsEnded() external {
        _fundNative(1 ether);

        bytes memory signature = _signClaim(CLAIMANT_PRIVATE_KEY);
        recovery.agreeToClaimConditions(claimant, signature);

        vm.prank(owner);
        recovery.endClaims();
        recovery.refund(address(0));

        uint256 recipientBalanceBefore = recipient.balance;

        vm.expectRevert(RecoveryFund.ClaimsAreEnded.selector);
        vm.prank(claimant);
        recovery.claim(recipient, address(0), 1 ether);

        assertEq(recovery.recoveryAmount(claimant, address(0)), 1 ether);
        assertEq(address(recovery).balance, 0);
        assertEq(recipient.balance, recipientBalanceBefore);
    }

    function _fundToken(uint256 amount) private {
        _allocateToken(amount);
        vm.prank(funder);
        assertTrue(token.transfer(address(recovery), amount));
    }

    function _allocateToken(uint256 amount) private {
        recovery = _deployRecovery(_singleClaim(claimant, address(token), amount));
    }

    function _fundNative(uint256 amount) private {
        _allocateNative(amount);
        vm.prank(funder);
        (bool success,) = address(recovery).call{value: amount}("");
        assertTrue(success);
    }

    function _allocateNative(uint256 amount) private {
        recovery = _deployRecovery(_singleClaim(claimant, address(0), amount));
    }

    function _deployRecovery(RecoveryFund.Claim[] memory claimList) private returns (RecoveryFund) {
        return new RecoveryFund(CLAIM_CONDITIONS, claimList, owner);
    }

    function _emptyClaims() private pure returns (RecoveryFund.Claim[] memory claimList) {
        claimList = new RecoveryFund.Claim[](0);
    }

    function _singleClaim(address claimOwner, address claimToken, uint256 amount)
        private
        pure
        returns (RecoveryFund.Claim[] memory claimList)
    {
        claimList = new RecoveryFund.Claim[](1);
        claimList[0] = RecoveryFund.Claim({claimant: claimOwner, token: claimToken, amount: amount});
    }

    function _signClaim(uint256 privateKey) private view returns (bytes memory) {
        bytes32 digest = recovery.claimConditionsDigest();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _claimConditionsDigest() private view returns (bytes32) {
        bytes32 structHash =
            keccak256(abi.encode(recovery.AGREE_TO_CLAIM_CONDITIONS_TYPEHASH(), keccak256(bytes(CLAIM_CONDITIONS))));
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
    }

    function _domainSeparator() private view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("Recovery Fund")),
                keccak256(bytes("1")),
                block.chainid,
                address(recovery)
            )
        );
    }
}
