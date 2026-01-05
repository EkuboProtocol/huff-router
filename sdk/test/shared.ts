import { Address, padHex, zeroAddress } from "viem";
import { ORACLE_ADDRESS } from "../src/extensions.js";

export const NATIVE_TOKEN_ADDRESS: Address = zeroAddress;
export const ERC20_FIRST_ADDRESS: Address = "0x1111111111111111111111111111111111111111";
export const ERC20_SECOND_ADDRESS: Address = "0x2222222222222222222222222222222222222222";
export const TOKEN_WRAPPER_ADDRESS: Address = "0x3333333333333333333333333333333333333333";

export const ORACLE_CONFIG = padHex(ORACLE_ADDRESS, { dir: "right" });

export const INTEGRATOR = "0x4a77e6131A6b8067042A0F9dDfaC9eB4cf18e219";
