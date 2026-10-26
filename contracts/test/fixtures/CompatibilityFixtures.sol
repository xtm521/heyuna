// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.38;

// Research probes only: these are not protocol contracts or privileged modules.
contract CompatibilityProbe {
    uint256 public value;
    mapping(uint256 => uint256) public slots;
    event Changed(uint256 indexed value, address sender);
    function set(uint256 next) external { value = next; emit Changed(next, msg.sender); }
    function fill() external { for (uint256 i; i < 20; i++) slots[i] = i + 1; }
    function clear() external { for (uint256 i; i < 20; i++) delete slots[i]; }
    function fail() external pure { revert("intentional research revert"); }
}

contract ConstructorBurnProbe {
    // Probe EIP-6780 for a contract created in this same transaction. Native
    // supply reconciliation is checked separately; status1 alone proves none.
    constructor() payable { selfdestruct(payable(address(this))); }
}
