import { defineConfig } from "@wagmi/cli";
import { foundry } from "@wagmi/cli/plugins"

export default defineConfig({
  out: "test/abi.ts",
  plugins: [
    foundry({
      "project": "../contracts",
      "exclude": [],
      "include": ["HyperRouter.t.sol/*"]
    })
  ],
});
