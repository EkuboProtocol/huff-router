import { readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TEST_CHAIN_ID, MAX_TOKEN_LIST_LENGTH, MAX_CONTRACT_SIZE } from "../shared.js";
import { getAddress, toHex } from "viem";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tokensDir = path.resolve(__dirname, "../../tokens");
const apiBaseUrl = "https://prod-api.ekubo.org";

const PAGE_SIZE = MAX_TOKEN_LIST_LENGTH + 1;
const [MIN_PRIORITY_START, MIN_PRIORITY_END] = [-1, 2];
const MIN_REQUEST_INTERVAL_MS = 1000 / 3;
const NATIVE_TOKEN_ADDRESS_BI = 0n;

type TokenResponse = {
    address: string;
};

let lastRequestTimeMs = 0;
const rateLimit = async (): Promise<void> => {
    const waitMs = Math.max(0, MIN_REQUEST_INTERVAL_MS - (Date.now() - lastRequestTimeMs));
    await new Promise(resolve => setTimeout(resolve, waitMs));

    lastRequestTimeMs = Date.now();
};

const chainIds = readdirSync(tokensDir)
    .map(file => Number(file.split(".")[0]))
    .filter(chainId => chainId !== TEST_CHAIN_ID);

const fetchTokens = async (chainId: number, minVisibilityPriority: number): Promise<Set<bigint>> => {
    await rateLimit();
    const params = new URLSearchParams({
        chainId: String(chainId),
        pageSize: String(PAGE_SIZE),
        minVisibilityPriority: String(minVisibilityPriority),
    });

    const res = await fetch(`${apiBaseUrl}/tokens?${params.toString()}`);
    if (!res.ok) {
        throw new Error(
            `Failed to fetch tokens for chain ${chainId} (minVisibilityPriority ${minVisibilityPriority}): ${res.status} ${res.statusText}`,
        );
    }

    const data = (await res.json()) as TokenResponse[];
    return new Set(data
        .map(token => BigInt(token.address))
        // A security invariant to make sure addresses can't be valid jump destinations
        .filter(token => token >= MAX_CONTRACT_SIZE));
};

for (const chainId of chainIds) {
    let previousSet = new Set<bigint>();
    let selected = new Set([NATIVE_TOKEN_ADDRESS_BI]);

    for (let priority = MIN_PRIORITY_START; priority <= MIN_PRIORITY_END; priority += 1) {
        const addresses = await fetchTokens(chainId, priority);
        addresses.add(NATIVE_TOKEN_ADDRESS_BI);

        if (addresses.size <= MAX_TOKEN_LIST_LENGTH) {
            selected = addresses;
            break;
        }

        previousSet = addresses;
    }

    for (const address of previousSet) {
        if (selected.size >= MAX_TOKEN_LIST_LENGTH) {
            break;
        }
        selected.add(address);
    }

    const selectedArr = Array.from(selected);
    selectedArr.sort((a, b) => (a < b) ? -1 : ((a > b) ? 1 : 0));

    const selectedAddresses = selectedArr.map(num => getAddress(toHex(num, { size: 20 })));

    writeFileSync(path.join(tokensDir, `${chainId}.json`), JSON.stringify(selectedAddresses, null, 4));

    console.log(`Updated token list for chain ${chainId} (${selectedArr.length} tokens).`);
}
