// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {RecoveryFund} from "../src/RecoveryFund.sol";

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/tokens/ERC20.sol";

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
    address private refundAddress = address(0x1234);
    address private funder = address(0xF00D);

    function setUp() public {
        claimant = vm.addr(CLAIMANT_PRIVATE_KEY);
        vm.expectEmit(true, false, false, true);
        emit RecoveryFund.ClaimConditions(keccak256(bytes(CLAIM_CONDITIONS)), CLAIM_CONDITIONS);
        recovery = new RecoveryFund(CLAIM_CONDITIONS, refundAddress, block.timestamp + 180 days);
        token = new RecoveryToken();

        token.mint(funder, 1_000 ether);
        vm.deal(funder, 100 ether);
    }

    function test_ConstructorStoresClaimConditionsHash() external view {
        assertEq(recovery.messageHash(), keccak256(bytes(CLAIM_CONDITIONS)));
        assertEq(recovery.domainSeparator(), _domainSeparator());
        assertEq(recovery.claimConditionsDigest(), _claimConditionsDigest());
        assertEq(recovery.refundAddress(), refundAddress);
        assertEq(recovery.refundTimestamp(), block.timestamp + 180 days);
    }

    function test_Eip712ClaimConditionsUsePlaintextStringField() external view {
        bytes32 stringTypeHash = keccak256("AgreeToClaimConditions(string claimConditions)");
        bytes32 bytes32TypeHash = keccak256("ClaimConditions(bytes32 messageHash)");

        assertEq(recovery.AGREE_TO_CLAIM_CONDITIONS_TYPEHASH(), stringTypeHash);
        assertNotEq(recovery.AGREE_TO_CLAIM_CONDITIONS_TYPEHASH(), bytes32TypeHash);

        bytes32 structHash = keccak256(abi.encode(stringTypeHash, keccak256(bytes(CLAIM_CONDITIONS))));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", recovery.domainSeparator(), structHash));

        assertEq(recovery.messageHash(), keccak256(bytes(CLAIM_CONDITIONS)));
        assertEq(recovery.claimConditionsDigest(), digest);
    }

    function test_FundErc20ForClaimant() external {
        vm.startPrank(funder);
        token.approve(address(recovery), 100 ether);

        vm.expectEmit(true, true, true, true, address(recovery));
        emit RecoveryFund.RecoveryFunded(funder, claimant, address(token), 100 ether);
        recovery.fund(claimant, address(token), 100 ether);
        vm.stopPrank();

        assertEq(recovery.recoveryAmount(claimant, address(token)), 100 ether);
        assertEq(token.balanceOf(address(recovery)), 100 ether);
    }

    function test_FundNativeForClaimant() external {
        vm.prank(funder);
        recovery.fund{value: 1 ether}(claimant, address(0), 1 ether);

        assertEq(recovery.recoveryAmount(claimant, address(0)), 1 ether);
        assertEq(address(recovery).balance, 1 ether);
    }

    function test_ClaimErc20WithValidSignature() external {
        _fundToken(100 ether);

        bytes memory signature = _signClaim(CLAIMANT_PRIVATE_KEY);

        vm.expectEmit(true, false, false, true, address(recovery));
        emit RecoveryFund.ClaimConditionsSigned(claimant, signature);
        recovery.agreeToClaimConditions(claimant, signature);

        vm.expectEmit(true, true, true, true, address(recovery));
        emit RecoveryFund.RecoveryClaimed(claimant, recipient, address(token), 40 ether);
        recovery.claim(claimant, recipient, address(token), 40 ether);

        assertEq(recovery.recoveryAmount(claimant, address(token)), 60 ether);
        assertTrue(recovery.hasSignedClaimConditions(claimant));
        assertEq(token.balanceOf(recipient), 40 ether);
    }

    function test_MulticallFundAndClaimErc20() external {
        bytes memory signature = _signClaim(CLAIMANT_PRIVATE_KEY);

        bytes[] memory data = new bytes[](3);
        data[0] = abi.encodeCall(RecoveryFund.fund, (claimant, address(token), 100 ether));
        data[1] = abi.encodeCall(RecoveryFund.agreeToClaimConditions, (claimant, signature));
        data[2] = abi.encodeCall(RecoveryFund.claim, (claimant, recipient, address(token), 40 ether));

        vm.startPrank(funder);
        token.approve(address(recovery), 100 ether);
        bytes[] memory results = recovery.multicall(data);
        vm.stopPrank();

        assertEq(results.length, 3);
        assertEq(results[0].length, 0);
        assertEq(results[1].length, 0);
        assertEq(results[2].length, 0);
        assertEq(recovery.recoveryAmount(claimant, address(token)), 60 ether);
        assertEq(token.balanceOf(recipient), 40 ether);
    }

    function test_ClaimNativeWithValidSignature() external {
        vm.prank(funder);
        recovery.fund{value: 1 ether}(claimant, address(0), 1 ether);

        bytes memory signature = _signClaim(CLAIMANT_PRIVATE_KEY);
        recovery.agreeToClaimConditions(claimant, signature);

        uint256 balanceBefore = recipient.balance;
        recovery.claim(claimant, recipient, address(0), 1 ether);

        assertEq(recovery.recoveryAmount(claimant, address(0)), 0);
        assertEq(recipient.balance - balanceBefore, 1 ether);
    }

    function testRevert_ClaimWithWrongSigner() external {
        _fundToken(100 ether);

        bytes memory signature = _signClaim(OTHER_PRIVATE_KEY);

        vm.expectRevert(RecoveryFund.InvalidSignature.selector);
        recovery.agreeToClaimConditions(claimant, signature);
    }

    function testRevert_ClaimWithoutAgreement() external {
        _fundToken(100 ether);

        vm.expectRevert(RecoveryFund.ClaimConditionsNotSigned.selector);
        recovery.claim(claimant, recipient, address(token), 40 ether);
    }

    function test_ClaimSignatureAllowsAnyFundedAmountAndRecipient() external {
        _fundToken(100 ether);

        bytes memory signature = _signClaim(CLAIMANT_PRIVATE_KEY);
        recovery.agreeToClaimConditions(claimant, signature);
        address secondRecipient = address(0xBEEF);

        recovery.claim(claimant, recipient, address(token), 25 ether);
        recovery.claim(claimant, secondRecipient, address(token), 30 ether);

        assertEq(recovery.recoveryAmount(claimant, address(token)), 45 ether);
        assertEq(token.balanceOf(recipient), 25 ether);
        assertEq(token.balanceOf(secondRecipient), 30 ether);
    }

    function test_ClaimSameSignatureAfterTopUp() external {
        _fundToken(40 ether);

        bytes memory signature = _signClaim(CLAIMANT_PRIVATE_KEY);
        recovery.agreeToClaimConditions(claimant, signature);

        recovery.claim(claimant, recipient, address(token), 40 ether);
        _fundToken(40 ether);
        recovery.claim(claimant, recipient, address(token), 40 ether);

        assertEq(recovery.recoveryAmount(claimant, address(token)), 0);
        assertEq(token.balanceOf(recipient), 80 ether);
    }

    function testRevert_ClaimMoreThanFunded() external {
        _fundToken(39 ether);

        bytes memory signature = _signClaim(CLAIMANT_PRIVATE_KEY);
        recovery.agreeToClaimConditions(claimant, signature);

        vm.expectRevert(RecoveryFund.InsufficientRecoveryAmount.selector);
        recovery.claim(claimant, recipient, address(token), 40 ether);
    }

    function testRevert_FundNativeWithWrongValue() external {
        vm.prank(funder);
        vm.expectRevert(RecoveryFund.InvalidFundingValue.selector);
        recovery.fund{value: 1 ether}(claimant, address(0), 2 ether);
    }

    function testRevert_FundErc20WithNativeValue() external {
        vm.prank(funder);
        vm.expectRevert(RecoveryFund.InvalidFundingValue.selector);
        recovery.fund{value: 1 ether}(claimant, address(token), 2 ether);
    }

    function test_RefundErc20AfterRefundTimestamp() external {
        _fundToken(100 ether);
        vm.warp(recovery.refundTimestamp());

        vm.expectEmit(true, true, false, true, address(recovery));
        emit RecoveryFund.RecoveryRefunded(address(this), address(token), 100 ether);
        recovery.refund(address(token));

        assertEq(token.balanceOf(refundAddress), 100 ether);
        assertEq(token.balanceOf(address(recovery)), 0);
    }

    function test_RefundNativeAfterRefundTimestamp() external {
        vm.prank(funder);
        recovery.fund{value: 1 ether}(claimant, address(0), 1 ether);
        vm.warp(recovery.refundTimestamp());

        uint256 balanceBefore = refundAddress.balance;
        recovery.refund(address(0));

        assertEq(refundAddress.balance - balanceBefore, 1 ether);
        assertEq(address(recovery).balance, 0);
    }

    function testRevert_RefundBeforeRefundTimestamp() external {
        _fundToken(100 ether);

        vm.expectRevert(RecoveryFund.RefundNotAvailable.selector);
        recovery.refund(address(token));
    }

    function testRevert_ClaimAfterRefundTimestamp() external {
        _fundToken(100 ether);
        vm.warp(recovery.refundTimestamp());

        bytes memory signature = _signClaim(CLAIMANT_PRIVATE_KEY);
        recovery.agreeToClaimConditions(claimant, signature);

        vm.expectRevert(RecoveryFund.ClaimPeriodOver.selector);
        recovery.claim(claimant, recipient, address(token), 40 ether);
    }

    function _fundToken(uint256 amount) private {
        vm.startPrank(funder);
        token.approve(address(recovery), amount);
        recovery.fund(claimant, address(token), amount);
        vm.stopPrank();
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
