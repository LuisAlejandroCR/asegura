// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/AseguraLedger.sol";

contract AseguraLedgerTest is Test {
    AseguraLedger ledger;
    address operator = address(0xBEEF);
    address attacker = address(0xBAD);

    function setUp() public {
        ledger = new AseguraLedger(operator);
    }

    // ── Unit ──────────────────────────────────────────────────────────────────
    function test_OperatorIsSet() public view {
        assertEq(ledger.operator(), operator);
    }

    function test_RegisterPolicy() public {
        vm.prank(operator);
        ledger.registerPolicy("pol-001", "https://asegura.co/pol-001");
        assertTrue(ledger.verifyPolicy("pol-001"));
    }

    function test_NonOperatorReverts() public {
        vm.prank(attacker);
        vm.expectRevert("AseguraLedger: not operator");
        ledger.registerPolicy("pol-002", "https://asegura.co/pol-002");
    }

    function test_DuplicateReverts() public {
        vm.startPrank(operator);
        ledger.registerPolicy("pol-003", "https://asegura.co/pol-003");
        vm.expectRevert("AseguraLedger: already registered");
        ledger.registerPolicy("pol-003", "https://asegura.co/pol-003");
        vm.stopPrank();
    }

    function test_EmitsEvent() public {
        bytes32 expectedHash = keccak256(abi.encodePacked("pol-004"));
        vm.expectEmit(true, true, false, true);
        emit AseguraLedger.PolicyRegistered(
            expectedHash, "pol-004", "https://asegura.co/pol-004", operator, block.timestamp
        );
        vm.prank(operator);
        ledger.registerPolicy("pol-004", "https://asegura.co/pol-004");
    }

    // ── Fuzz ──────────────────────────────────────────────────────────────────
    function testFuzz_RegisterAnyPolicyId(string calldata policyId, string calldata uri) public {
        vm.assume(bytes(policyId).length > 0);
        vm.prank(operator);
        ledger.registerPolicy(policyId, uri);
        assertTrue(ledger.verifyPolicy(policyId));
    }

    // ── Invariant ─────────────────────────────────────────────────────────────
    function invariant_OperatorNeverChanges() public view {
        assertEq(ledger.operator(), operator);
    }
}
