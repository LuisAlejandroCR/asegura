// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/AseguraLedger.sol";

contract DeployAseguraLedger is Script {
    function run() external {
        address operatorWallet = vm.envAddress("OPERATOR_WALLET");

        vm.startBroadcast();
        AseguraLedger ledger = new AseguraLedger(operatorWallet);
        vm.stopBroadcast();

        console.log("AseguraLedger deployed at:", address(ledger));
        console.log("Operator:", operatorWallet);
        console.log("Set POLICY_LEDGER_ADDRESS=", address(ledger));
    }
}
