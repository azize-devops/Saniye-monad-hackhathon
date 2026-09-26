// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title SaniyePay — pay-per-second for real-world services on Monad
/// @notice A user locks a deposit and starts a session. When they stop, they pay exactly
///         elapsedSeconds * ratePerSecond; the rest is refunded in the same transaction.
///         Only start/stop touch the chain; the live counter is computed by the frontend.
contract SaniyePay {
    struct Service {
        address owner;
        uint128 ratePerSecond; // wei of MON per second
        uint32 activeCount;
        bool exists;
        string name;
    }

    struct Session {
        uint64 serviceId;
        uint64 startedAt; // block.timestamp (second granularity is exactly our billing unit)
        uint128 deposit;
        bool active;
    }

    uint16 public constant FEE_BPS = 100; // 1% platform fee
    uint32 public constant MIN_PREPAID_SECONDS = 60; // deposit must cover at least 1 minute

    address public immutable treasury;
    uint64 public nextServiceId = 1;

    mapping(uint64 => Service) public services;
    mapping(address => Session) public sessions;
    mapping(address => uint256) public earnings; // withdrawable balances (owners + treasury)

    // active users per service, for the business dashboard (swap-and-pop)
    mapping(uint64 => address[]) private _activeUsers;
    mapping(address => uint256) private _activeIndex;

    event ServiceRegistered(uint64 indexed serviceId, address indexed owner, string name, uint128 ratePerSecond);
    event SessionStarted(address indexed user, uint64 indexed serviceId, uint128 deposit, uint64 startedAt);
    event SessionStopped(
        address indexed user, uint64 indexed serviceId, uint64 elapsed, uint256 cost, uint256 refund, address stoppedBy
    );
    event Withdrawn(address indexed to, uint256 amount);

    error UnknownService();
    error SessionAlreadyActive();
    error NoActiveSession();
    error DepositTooSmall(uint256 minimum);
    error NotAllowed();
    error NothingToWithdraw();
    error TransferFailed();
    error InvalidRate();

    constructor() {
        treasury = msg.sender;
    }

    // ------------------------------------------------------------------ services

    function registerService(string calldata name, uint128 ratePerSecond) external returns (uint64 id) {
        if (ratePerSecond == 0) revert InvalidRate();
        id = nextServiceId++;
        services[id] = Service({owner: msg.sender, ratePerSecond: ratePerSecond, activeCount: 0, exists: true, name: name});
        emit ServiceRegistered(id, msg.sender, name, ratePerSecond);
    }

    // ------------------------------------------------------------------ sessions

    function start(uint64 serviceId) external payable {
        Service storage s = services[serviceId];
        if (!s.exists) revert UnknownService();
        if (sessions[msg.sender].active) revert SessionAlreadyActive();
        uint256 minimum = uint256(s.ratePerSecond) * MIN_PREPAID_SECONDS;
        if (msg.value < minimum) revert DepositTooSmall(minimum);

        sessions[msg.sender] = Session({
            serviceId: serviceId,
            startedAt: uint64(block.timestamp),
            deposit: uint128(msg.value),
            active: true
        });
        s.activeCount += 1;
        _activeIndex[msg.sender] = _activeUsers[serviceId].length;
        _activeUsers[serviceId].push(msg.sender);

        emit SessionStarted(msg.sender, serviceId, uint128(msg.value), uint64(block.timestamp));
    }

    /// @notice Stop your own session: pay for the seconds used, get the rest back instantly.
    function stop() external {
        _settle(msg.sender);
    }

    /// @notice The service owner can close a session whose deposit has run out.
    function forceStop(address user) external {
        Session storage ses = sessions[user];
        if (!ses.active) revert NoActiveSession();
        Service storage s = services[ses.serviceId];
        if (msg.sender != s.owner) revert NotAllowed();
        (, uint256 cost,) = quote(user);
        if (cost < ses.deposit) revert NotAllowed(); // deposit not exhausted yet
        _settle(user);
    }

    function _settle(address user) internal {
        Session memory ses = sessions[user];
        if (!ses.active) revert NoActiveSession();
        Service storage s = services[ses.serviceId];

        (uint64 elapsed, uint256 cost, uint256 refund) = quote(user);

        // effects
        delete sessions[user];
        s.activeCount -= 1;
        _removeActive(ses.serviceId, user);

        uint256 fee = (cost * FEE_BPS) / 10_000;
        earnings[s.owner] += cost - fee;
        earnings[treasury] += fee;

        emit SessionStopped(user, ses.serviceId, elapsed, cost, refund, msg.sender);

        // interaction
        if (refund > 0) {
            (bool ok,) = payable(user).call{value: refund}("");
            if (!ok) revert TransferFailed();
        }
    }

    function withdraw() external {
        uint256 amount = earnings[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        earnings[msg.sender] = 0;
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);
    }

    // ------------------------------------------------------------------ views

    /// @return elapsed seconds used so far, cost owed so far (capped at deposit), refund if stopped now
    function quote(address user) public view returns (uint64 elapsed, uint256 cost, uint256 refund) {
        Session memory ses = sessions[user];
        if (!ses.active) return (0, 0, 0);
        elapsed = uint64(block.timestamp) - ses.startedAt;
        cost = uint256(elapsed) * services[ses.serviceId].ratePerSecond;
        if (cost > ses.deposit) cost = ses.deposit;
        refund = ses.deposit - cost;
    }

    function activeUsers(uint64 serviceId) external view returns (address[] memory) {
        return _activeUsers[serviceId];
    }

    function _removeActive(uint64 serviceId, address user) private {
        address[] storage list = _activeUsers[serviceId];
        uint256 i = _activeIndex[user];
        uint256 last = list.length - 1;
        if (i != last) {
            address moved = list[last];
            list[i] = moved;
            _activeIndex[moved] = i;
        }
        list.pop();
        delete _activeIndex[user];
    }
}
