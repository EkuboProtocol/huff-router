import { Address } from "viem";
import TOKENS_1 from "../../tokens/1.json" with { "type": "json" };
import TOKENS_10 from "../../tokens/10.json" with { "type": "json" };
import TOKENS_56 from "../../tokens/56.json" with { "type": "json" };
import TOKENS_130 from "../../tokens/130.json" with { "type": "json" };
import TOKENS_137 from "../../tokens/137.json" with { "type": "json" };
import TOKENS_250 from "../../tokens/250.json" with { "type": "json" };
import TOKENS_324 from "../../tokens/324.json" with { "type": "json" };
import TOKENS_480 from "../../tokens/480.json" with { "type": "json" };
import TOKENS_1868 from "../../tokens/1868.json" with { "type": "json" };
import TOKENS_8453 from "../../tokens/8453.json" with { "type": "json" };
import TOKENS_31337 from "../../tokens/31337.json" with { "type": "json" };
import TOKENS_42161 from "../../tokens/42161.json" with { "type": "json" };
import TOKENS_43114 from "../../tokens/43114.json" with { "type": "json" };
import TOKENS_57073 from "../../tokens/57073.json" with { "type": "json" };
import TOKENS_59144 from "../../tokens/59144.json" with { "type": "json" };

const asAddressList = (list: string[]): Address[] => list as Address[];

export class Tokens {
    private constructor(public list: Address[]) { }

    private static byChainId = new Map<bigint, Tokens>([
        [1n, new Tokens(asAddressList(TOKENS_1))],
        [10n, new Tokens(asAddressList(TOKENS_10))],
        [56n, new Tokens(asAddressList(TOKENS_56))],
        [130n, new Tokens(asAddressList(TOKENS_130))],
        [137n, new Tokens(asAddressList(TOKENS_137))],
        [250n, new Tokens(asAddressList(TOKENS_250))],
        [324n, new Tokens(asAddressList(TOKENS_324))],
        [480n, new Tokens(asAddressList(TOKENS_480))],
        [1868n, new Tokens(asAddressList(TOKENS_1868))],
        [8453n, new Tokens(asAddressList(TOKENS_8453))],
        [31337n, new Tokens(asAddressList(TOKENS_31337))],
        [42161n, new Tokens(asAddressList(TOKENS_42161))],
        [43114n, new Tokens(asAddressList(TOKENS_43114))],
        [57073n, new Tokens(asAddressList(TOKENS_57073))],
        [59144n, new Tokens(asAddressList(TOKENS_59144))],
    ]);

    static load(chainId: bigint): Tokens | null {
        return this.byChainId.get(chainId) ?? null;
    }

    id(address: string): number | null {
        const idx = this.list.findIndex(token => token === address);
        return idx === -1 ? null : idx;
    }
}
