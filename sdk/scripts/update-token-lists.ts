import { readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  TEST_CHAIN_ID,
  MAX_TOKEN_LIST_LENGTH,
  MAX_CONTRACT_SIZE,
} from "../shared.js";
import { getAddress, toHex } from "viem";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tokensDir = path.resolve(__dirname, "../../tokens");
const apiBaseUrl = "https://prod-api.ekubo.org";

const PAGE_SIZE = 1000;
const MIN_VISIBILITY_PRIORITY = -100;
const HIGH_VISIBILITY_PRIORITY = 1000000000;
const MIN_REQUEST_INTERVAL_MS = 1000 / 3;
const NATIVE_TOKEN_ADDRESS_BI = 0n;

type TokenResponse = {
  address: string;
  visibility_priority: number;
};

let lastRequestTimeMs = 0;
const rateLimit = async (): Promise<void> => {
  const waitMs = Math.max(
    0,
    MIN_REQUEST_INTERVAL_MS - (Date.now() - lastRequestTimeMs),
  );
  await new Promise((resolve) => setTimeout(resolve, waitMs));

  lastRequestTimeMs = Date.now();
};

const chainIds = readdirSync(tokensDir)
  .map((file) => Number(file.split(".")[0]))
  .filter((chainId) => chainId !== TEST_CHAIN_ID);

const fetchTokens = async (chainId: number): Promise<TokenResponse[]> => {
  await rateLimit();
  const params = new URLSearchParams({
    chainId: String(chainId),
    pageSize: String(PAGE_SIZE),
    minVisibilityPriority: String(MIN_VISIBILITY_PRIORITY),
  });

  const res = await fetch(`${apiBaseUrl}/tokens?${params.toString()}`);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch tokens for chain ${chainId}: ${res.status} ${res.statusText}`,
    );
  }

  return (await res.json()) as TokenResponse[];
};

for (const chainId of chainIds) {
  const tokens = (await fetchTokens(chainId)).map((token) => ({
    address: BigInt(token.address),
    visibilityPriority: token.visibility_priority,
  }));

  // A security invariant to make sure addresses can't be valid jump destinations
  const filteredTokens = tokens.filter(
    (token) => token.address >= MAX_CONTRACT_SIZE,
  );

  filteredTokens.push({
    address: NATIVE_TOKEN_ADDRESS_BI,
    visibilityPriority: Number.POSITIVE_INFINITY,
  });

  const tokenAddresses = filteredTokens
    .sort((a, b) => b.visibilityPriority - a.visibilityPriority)
    .slice(0, MAX_TOKEN_LIST_LENGTH)
    .sort((a, b) => (a.address < b.address ? -1 : 1))
    .map((token) => getAddress(toHex(token.address, { size: 20 })));

  writeFileSync(
    path.join(tokensDir, `${chainId}.json`),
    JSON.stringify(tokenAddresses, null, 4),
  );

  console.log(
    `Updated token list for chain ${chainId} (${tokenAddresses.length} tokens).`,
  );
}
