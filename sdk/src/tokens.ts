import { Address } from "viem";

export class Tokens {
    private static tokensMap = new Map<bigint, Tokens | null>();

    private constructor(public list: Address[]) { }

    static async load(chainId: bigint): Promise<Tokens | null> {
        const lookupRes = this.tokensMap.get(chainId);
        if (typeof lookupRes !== "undefined") {
            return lookupRes;
        }

        // Sanitize to be safe
        chainId = BigInt(chainId);

        let list: Address[];
        try {
            list = (await import(`../../tokens/${chainId}.json`, { with: { type: "json" } })).default;
        } catch (err) {
            this.tokensMap.set(chainId, null);
            return null;
        }

        const tokens = new Tokens(list);
        this.tokensMap.set(chainId, tokens);

        return tokens;
    }

    id(address: string): number | null {
        const idx = this.list.findIndex(token => token === address);
        return idx === -1 ? null : idx;
    }
}
