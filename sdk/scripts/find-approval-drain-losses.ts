#!/usr/bin/env tsx
import {
    TRACE_CONCURRENCY,
    analyzeTransaction,
    findPotentialExploitTraces,
    isIgnoredTransaction,
    mapConcurrent,
    summarizeVictimLosses,
} from "./find-approval-drain-losses/search.ts";
import {
    getChainConfigs,
    writeReports,
} from "./find-approval-drain-losses/io.ts";

try {
    for (const { affectedDeployments, chainId, client, name } of getChainConfigs()) {
        console.log(`Scanning ${affectedDeployments.deployments.length} ${name} deployment(s) from block ${affectedDeployments.startBlock}...`);

        const potentialExploitTraces = await findPotentialExploitTraces(client, affectedDeployments);
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

        const rows = (
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

        const summaries = summarizeVictimLosses(rows);
        const outDir = await writeReports(rows, summaries);

        console.log(`Wrote ${rows.length} incident row(s) and ${summaries.length} victim summary row(s) to ${outDir}`);
    }
} catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exitCode = 1;
}
