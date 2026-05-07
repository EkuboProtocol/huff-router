#!/usr/bin/env tsx
import {
    TRACE_CONCURRENCY,
    analyzeTransaction,
    enrichRowsWithTokenMetadata,
    findPotentialExploitTraces,
    isIgnoredTransaction,
    mapConcurrent,
    summarizeVictimLosses,
} from "./find-approval-drain-losses/search.ts";
import {
    getChainConfigs,
    loadTokenMetadataMap,
    writeReports,
} from "./find-approval-drain-losses/io.ts";

try {
    for (const { affectedDeployments, chainId, client, name } of getChainConfigs()) {
        console.log(`Scanning ${affectedDeployments.deployments.length} ${name} deployment(s) from block ${affectedDeployments.startBlock}...`);

        const potentialExploitTraces = await findPotentialExploitTraces(client, chainId, affectedDeployments);
        const tracesByTxHash = new Map<string, typeof potentialExploitTraces>();

        for (const potentialExploitTrace of potentialExploitTraces) {
            const txHash = potentialExploitTrace.trace.transactionHash;
            const existing = tracesByTxHash.get(txHash);
            if (typeof existing === "undefined") {
                tracesByTxHash.set(txHash, [potentialExploitTrace]);
            } else {
                existing.push(potentialExploitTrace);
            }
        }

        console.log(`  found ${potentialExploitTraces.length} potential exploit traces across ${tracesByTxHash.size} transaction(s)`);
        const txEntries = Array.from(tracesByTxHash.entries()).filter(([txHash]) => !isIgnoredTransaction(txHash));
        const ignoredTransactionCount = tracesByTxHash.size - txEntries.length;
        if (ignoredTransactionCount > 0) {
            console.log(`  skipping ${ignoredTransactionCount} ignored transaction(s)`);
        }

        console.log("Analyzing individual transactions...");
        let processedTransactions = 0;

        const rawRows = (
            await mapConcurrent(
                txEntries,
                TRACE_CONCURRENCY,
                async ([txHash, traces]) => {
                    try {
                        const rows = await analyzeTransaction(
                            client,
                            chainId,
                            affectedDeployments.deployments,
                            traces,
                            txHash as `0x${string}`,
                        );
                        processedTransactions += 1;
                        console.log(`  processed ${processedTransactions}/${txEntries.length}: ${txHash} (${rows.length} row(s))`);
                        return rows;
                    } catch (error) {
                        processedTransactions += 1;
                        console.log(`  failed ${processedTransactions}/${txEntries.length}: ${txHash}`);
                        throw error;
                    }
                },
            )
        ).flat();

        const uniqueTokens = [...new Set(rawRows.map((row) => row.token))];
        const metadataByToken = await loadTokenMetadataMap({
            chainId,
            client,
            concurrency: TRACE_CONCURRENCY,
            tokens: uniqueTokens,
        });

        const enrichedRows = enrichRowsWithTokenMetadata(rawRows, metadataByToken);
        const summaries = summarizeVictimLosses(enrichedRows);
        const outDir = await writeReports(enrichedRows, summaries);

        console.log(`Wrote ${enrichedRows.length} incident row(s) and ${summaries.length} victim summary row(s) to ${outDir}`);
    }
} catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exitCode = 1;
}
