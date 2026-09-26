// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SaniyePay} from "../src/SaniyePay.sol";

contract SaniyePayTest is Test {
    SaniyePay pay;
    address treasury = address(this);
    address owner = makeAddr("owner");
    address user = makeAddr("user");
    uint128 constant RATE = 0.0001 ether; // per second
    uint64 id;

    receive() external payable {}

    function setUp() public {
        pay = new SaniyePay();
        vm.prank(owner);
        id = pay.registerService("Kadikoy Otopark", RATE);
        vm.deal(user, 10 ether);
    }

    function test_PaysOnlyElapsedSeconds() public {
        vm.prank(user);
        pay.start{value: 1 ether}(id);

        vm.warp(block.timestamp + 125);
        uint256 before = user.balance;
        vm.prank(user);
        pay.stop();

        uint256 cost = 125 * uint256(RATE);
        assertEq(user.balance - before, 1 ether - cost, "refund");
        uint256 fee = cost / 100;
        assertEq(pay.earnings(owner), cost - fee, "owner earnings");
        assertEq(pay.earnings(treasury), fee, "platform fee");
        assertEq(pay.activeUsers(id).length, 0);
    }

    function test_RevertWhen_DepositBelowOneMinute() public {
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(SaniyePay.DepositTooSmall.selector, uint256(RATE) * 60));
        pay.start{value: uint256(RATE) * 59}(id);
    }

    function test_RevertWhen_DoubleStart() public {
        vm.startPrank(user);
        pay.start{value: 1 ether}(id);
        vm.expectRevert(SaniyePay.SessionAlreadyActive.selector);
        pay.start{value: 1 ether}(id);
        vm.stopPrank();
    }

    function test_ForceStopOnlyWhenExhausted() public {
        vm.prank(user);
        pay.start{value: uint256(RATE) * 60}(id);

        vm.warp(block.timestamp + 30);
        vm.prank(owner);
        vm.expectRevert(SaniyePay.NotAllowed.selector);
        pay.forceStop(user);

        vm.warp(block.timestamp + 100);
        vm.prank(owner);
        pay.forceStop(user);
        assertEq(pay.earnings(owner), uint256(RATE) * 60 - (uint256(RATE) * 60) / 100);
    }

    function test_Withdraw() public {
        vm.prank(user);
        pay.start{value: 1 ether}(id);
        vm.warp(block.timestamp + 10);
        vm.prank(user);
        pay.stop();

        uint256 e = pay.earnings(owner);
        vm.prank(owner);
        pay.withdraw();
        assertEq(owner.balance, e);
        vm.prank(owner);
        vm.expectRevert(SaniyePay.NothingToWithdraw.selector);
        pay.withdraw();
    }

    function testFuzz_NeverChargesMoreThanDeposit(uint32 secs, uint96 deposit) public {
        deposit = uint96(bound(deposit, uint256(RATE) * 60, 5 ether));
        vm.prank(user);
        pay.start{value: deposit}(id);
        vm.warp(block.timestamp + secs);
        uint256 before = user.balance;
        vm.prank(user);
        pay.stop();
        assertLe(deposit - (user.balance - before), deposit);
        assertEq(address(pay).balance, pay.earnings(owner) + pay.earnings(treasury));
    }
}
