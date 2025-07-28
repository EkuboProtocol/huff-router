// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

interface ILocker {
    function locked(uint256 id) external;
}

interface IPayer {
    function payCallback(uint256 id, address token) external;
}
