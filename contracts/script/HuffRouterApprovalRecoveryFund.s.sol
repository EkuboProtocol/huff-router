// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {RecoveryFund} from "../src/RecoveryFund.sol";

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

contract HuffRouterApprovalRecoveryFundScript is Script {
    struct TokenFunding {
        address token;
        uint256 amount;
    }

    address internal constant EKUBO = 0x04C46E830Bb56ce22735d5d8Fc9CB90309317d0f;
    address internal constant LINK = 0x514910771AF9Ca656af840dff83E8264EcF986CA;
    address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant WBTC = 0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599;
    address internal constant USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
    address internal constant CBBTC = 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf;
    address internal constant REFUND_ADDRESS = 0x1E0EF4162e42C9bF820c307218c4E41cCcA6E9CC;
    uint256 internal constant REFUND_DELAY = 180 days;

    TokenFunding[] internal tokenFundingScratch;

    function run() external returns (RecoveryFund recoveryFund) {
        RecoveryFund.Claim[] memory claimList = claims();
        TokenFunding[] memory fundings = _tokenFundings(claimList);

        vm.startBroadcast();

        recoveryFund = new RecoveryFund(claimConditions(), claimList, REFUND_ADDRESS, block.timestamp + REFUND_DELAY);
        console2.log("RecoveryFund deployed at", address(recoveryFund));

        for (uint256 i = 0; i < fundings.length; i++) {
            console2.log("Funding token", fundings[i].token);
            console2.log("Funding amount", fundings[i].amount);
            _fund(fundings[i].token, address(recoveryFund), fundings[i].amount);
        }

        vm.stopBroadcast();
    }

    function claimConditions() public pure returns (string memory) {
        return string.concat(
            "By signing this message, I accept the conditions for claiming from this Recovery Fund.\n\n",
            "I represent that I am not a sanctioned person, am not located, organized, or resident in a sanctioned ",
            "or embargoed jurisdiction, am not owned or controlled by a sanctioned person, and am not otherwise ",
            "prohibited by law from receiving these funds.\n\n",
            "I understand that any recovery distribution is voluntary, discretionary, and ex gratia by the Ekubo DAO. ",
            "I have no contractual, statutory, equitable, or other entitlement to any recovery distribution. Neither ",
            "the Ekubo interface, any Ekubo-related smart contract, nor any current or future deployment of the same, ",
            "similar, derivative, replacement, or related code is provided with any warranty, guarantee, or undertaking. ",
            "Applicable terms and smart contract disclaimers disclaim warranties and limit liability to the fullest ",
            "extent permitted by law.\n\n",
            "In exchange for my ability to claim from this Recovery Fund, to the fullest extent permitted by law, ",
            "I irrevocably and forever release, waive, discharge, and covenant not to sue the Ekubo DAO tokenholders, ",
            "Ekubo, Inc., and Ekubo, Inc.'s current and former employees, officers, directors, contractors, agents, ",
            "affiliates, successors, and assigns (the Released Parties) from any and all claims, demands, causes of ",
            "action, liabilities, losses, damages, costs, and expenses, whether known or unknown, suspected or ",
            "unsuspected, arising out of or relating to any hack, exploit, vulnerability, bug, incident, approval, ",
            "transfer, loss, or other consequence involving eip155:1:0x8f52903d17e2d8d6c77d1a1de0cc975b6b5a0d15, ",
            "eip155:1:0x8ccb1ffd5c2aa6bd926473425dea4c8c15de60fd, ",
            "eip155:1:0x4f168f17923435c999f5c8565acab52c2218edf2, or ",
            "eip155:42161:0xc93c4ad185ca48d66fefe80f906a67ef859fc47d."
        );
    }

    function tokenFundings() public returns (TokenFunding[] memory fundings) {
        return _tokenFundings(claims());
    }

    function claims() public pure returns (RecoveryFund.Claim[] memory claimList) {
        claimList = new RecoveryFund.Claim[](34);
        claimList[0] =
            RecoveryFund.Claim({claimant: 0x0DE3f84782427380c6588A9dCA8675A5c40893Cb, token: USDC, amount: 22000000});
        claimList[1] = RecoveryFund.Claim({
            claimant: 0x1C3949EF079A741974a8EaB0779F8F6A1D1C1001, token: EKUBO, amount: 5417488498305846470
        });
        claimList[2] =
            RecoveryFund.Claim({claimant: 0x1D088bd797234564633f30cCD44A6A1518C5B533, token: USDC, amount: 996000000});
        claimList[3] = RecoveryFund.Claim({
            claimant: 0x282c8d5CAD767a93e1E042E33E7A15877A8E6A1b, token: EKUBO, amount: 1619916699131518517073
        });
        claimList[4] =
            RecoveryFund.Claim({claimant: 0x300afbE08EE4619EC93524f9255CE59a013a5b63, token: USDC, amount: 51527625});
        claimList[5] =
            RecoveryFund.Claim({claimant: 0x37e6F903fa568BD3e8f49106A6912ae177de531F, token: USDT, amount: 1569968});
        claimList[6] =
            RecoveryFund.Claim({claimant: 0x3f9564E5F644e1B485B3Bc95ffbB255291eeb2df, token: USDC, amount: 2758000000});
        claimList[7] =
            RecoveryFund.Claim({claimant: 0x4192F6865c2bd788fE725a49c757D7dCd64Fc85E, token: USDC, amount: 970000000});
        claimList[8] = RecoveryFund.Claim({
            claimant: 0x59653fd9713a30C54237A6FD21fD97BA141aBbe0, token: EKUBO, amount: 332999997742626184611
        });
        claimList[9] =
            RecoveryFund.Claim({claimant: 0x6229F7195550D13Fd5B8781aa3B21C6b78Ff0F9A, token: USDC, amount: 264000000});
        claimList[10] =
            RecoveryFund.Claim({claimant: 0x67D2c5E0c19AfdCBa7E3AAd3D10A07F82C167106, token: USDC, amount: 2000000000});
        claimList[11] = RecoveryFund.Claim({
            claimant: 0x6954ba40D5787041D7D1DBc091E0197C6566E910, token: EKUBO, amount: 3102034662139479345546
        });
        claimList[12] =
            RecoveryFund.Claim({claimant: 0x765Ccb397c36d5767BAfddB7865497EC7AA1367d, token: USDC, amount: 2370000});
        claimList[13] =
            RecoveryFund.Claim({claimant: 0x765DECF4Fa157756e850C1079F60801b9219Edd1, token: CBBTC, amount: 34386474});
        claimList[14] =
            RecoveryFund.Claim({claimant: 0x8B3997e0a91DDF63585aBbC032C406F47ad45633, token: USDC, amount: 29658979});
        claimList[15] =
            RecoveryFund.Claim({claimant: 0x93C10b5B55ACA304086De9D0de20461bCE998cBB, token: USDC, amount: 424});
        claimList[16] = RecoveryFund.Claim({
            claimant: 0x95a3afd9B4548B05b78913c840BAe714007f7696, token: EKUBO, amount: 10388749244921397061
        });
        claimList[17] =
            RecoveryFund.Claim({claimant: 0x99935B671af8fFc9A9eD042E4663a135dA477b6c, token: USDT, amount: 1000000});
        claimList[18] =
            RecoveryFund.Claim({claimant: 0x9a40cc1bf43d2A70913E2bF5eE599C82006a2482, token: USDC, amount: 4800000});
        claimList[19] =
            RecoveryFund.Claim({claimant: 0x9A80E3B4EAa6a0cdce51D3548CfB27F06De43819, token: USDC, amount: 910000000});
        claimList[20] = RecoveryFund.Claim({
            claimant: 0x9D5C702Ef93211090524497670F5782B09623f0d, token: EKUBO, amount: 758596396128683675309
        });
        claimList[21] = RecoveryFund.Claim({
            claimant: 0x9D5C702Ef93211090524497670F5782B09623f0d, token: USDC, amount: 10076000000
        });
        claimList[22] =
            RecoveryFund.Claim({claimant: 0xa3653544812105B666a11b2D98c64CAbF8cBAEec, token: USDC, amount: 8870000});
        claimList[23] = RecoveryFund.Claim({
            claimant: 0xa3C1C91403F0026b9dd086882aDbC8Cdbc3b3cfB, token: LINK, amount: 550329927867664502
        });
        claimList[24] =
            RecoveryFund.Claim({claimant: 0xa3C1C91403F0026b9dd086882aDbC8Cdbc3b3cfB, token: USDC, amount: 12000000});
        claimList[25] =
            RecoveryFund.Claim({claimant: 0xa8b560111194192194c344F859d1C0A248747A6C, token: USDT, amount: 814016});
        claimList[26] =
            RecoveryFund.Claim({claimant: 0xadd179224B9895BD773e9550D84505E1365427Ea, token: USDC, amount: 53000000});
        claimList[27] =
            RecoveryFund.Claim({claimant: 0xb0d3ad8bb824b124d5BD9d0d56ca2298C2172e8f, token: USDT, amount: 88999986});
        claimList[28] =
            RecoveryFund.Claim({claimant: 0xb9c967Aa41292Ff7aFE2AdCD0eE04D302A88e8dD, token: USDC, amount: 1000000000});
        claimList[29] =
            RecoveryFund.Claim({claimant: 0xd36581554Fe70B946bC2708B772CfA30C8A6AddA, token: USDC, amount: 392780760});
        claimList[30] =
            RecoveryFund.Claim({claimant: 0xdC9629AF31cA26516910D31b0C843FC6FdC8F0b7, token: USDC, amount: 936000000});
        claimList[31] =
            RecoveryFund.Claim({claimant: 0xf6Ae934ddBEC4184f924BE503c366473797F44ee, token: USDC, amount: 63000000});
        claimList[32] =
            RecoveryFund.Claim({claimant: 0xfC011860c9E4B840AB97c2c3936611c88fcE3673, token: WBTC, amount: 99000});
        claimList[33] =
            RecoveryFund.Claim({claimant: 0x765DECF4Fa157756e850C1079F60801b9219Edd1, token: WBTC, amount: 1701484735});
    }

    function _fund(address token, address recoveryFund, uint256 amount) internal {
        if (token == address(0)) {
            SafeTransferLib.safeTransferETH(recoveryFund, amount);
        } else {
            SafeTransferLib.safeTransfer(token, recoveryFund, amount);
        }
    }

    function _tokenFundings(RecoveryFund.Claim[] memory claimList) internal returns (TokenFunding[] memory fundings) {
        delete tokenFundingScratch;

        for (uint256 i = 0; i < claimList.length; i++) {
            _addTokenFunding(claimList[i].token, claimList[i].amount);
        }

        fundings = new TokenFunding[](tokenFundingScratch.length);
        for (uint256 i = 0; i < tokenFundingScratch.length; i++) {
            fundings[i] = tokenFundingScratch[i];
        }
    }

    function _addTokenFunding(address token, uint256 amount) internal {
        for (uint256 i = 0; i < tokenFundingScratch.length; i++) {
            if (tokenFundingScratch[i].token == token) {
                tokenFundingScratch[i].amount += amount;
                return;
            }
        }

        tokenFundingScratch.push(TokenFunding({token: token, amount: amount}));
    }
}
