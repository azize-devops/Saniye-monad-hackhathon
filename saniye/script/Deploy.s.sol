// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {SaniyePay} from "../src/SaniyePay.sol";

/// forge script script/Deploy.s.sol --rpc-url monad_testnet --private-key $PRIVATE_KEY --broadcast
contract Deploy is Script {
    function run() external {
        vm.startBroadcast();
        SaniyePay pay = new SaniyePay();
        // Demo service: 0.18 MON per hour = 0.00005 MON per second
        uint64 id = pay.registerService("Kadikoy Otopark", 0.00005 ether);
        vm.stopBroadcast();

        console.log("SaniyePay:", address(pay));
        console.log("Demo service id:", id);
    }
}
