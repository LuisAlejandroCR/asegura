// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title AseguraLedger
/// @notice Immutable audit trail for Colsubsidio insurance policies. No custody of funds.
contract AseguraLedger {
    // ── Events ───────────────────────────────────────────────────────────────
    event PolicyRegistered(
        bytes32 indexed policyHash,
        string  policyId,
        string  referenceURI,
        address indexed operator,
        uint256 timestamp
    );

    // ── State ─────────────────────────────────────────────────────────────────
    address public immutable operator;
    mapping(bytes32 => bool) public isRegistered;

    // ── Constructor ───────────────────────────────────────────────────────────
    constructor(address _operator) {
        require(_operator != address(0), "AseguraLedger: zero address");
        operator = _operator;
    }

    // ── Modifiers ─────────────────────────────────────────────────────────────
    modifier onlyOperator() {
        require(msg.sender == operator, "AseguraLedger: not operator");
        _;
    }

    // ── External ──────────────────────────────────────────────────────────────
    /// @param policyId   Off-chain UUID from the policies table
    /// @param referenceURI  Public URL with policy metadata (no PII)
    function registerPolicy(
        string calldata policyId,
        string calldata referenceURI
    ) external onlyOperator {
        bytes32 policyHash = keccak256(abi.encodePacked(policyId));

        // Checks
        require(!isRegistered[policyHash], "AseguraLedger: already registered");

        // Effects
        isRegistered[policyHash] = true;

        // Interactions (emit only — no external calls)
        emit PolicyRegistered(
            policyHash,
            policyId,
            referenceURI,
            msg.sender,
            block.timestamp
        );
    }

    /// @notice Read-only helper for front-end verification
    function verifyPolicy(string calldata policyId) external view returns (bool) {
        return isRegistered[keccak256(abi.encodePacked(policyId))];
    }
}
