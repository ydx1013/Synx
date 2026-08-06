import type { RepoCommit } from '@synx/shared';
import type { HistorySyncOptions } from './historyIndex.js';
import type { RepositoryClient } from './repositoryClient.js';
import { isDirectTransportIncompatible } from './repositoryTransportSelector.js';

interface HistoryIndexWriter {
  syncFromHead(
    headCommitId: string,
    readCommit: (commitId: string) => Promise<RepoCommit | null>,
    options?: HistorySyncOptions,
  ): Promise<{ indexed: number; rebuilt: boolean }>;
}

export async function syncHistoryIndex(
  preferred: RepositoryClient,
  worker: RepositoryClient,
  writer: HistoryIndexWriter,
  signal: AbortSignal,
): Promise<void> {
  const run = async (client: RepositoryClient): Promise<void> => {
    throwIfAborted(signal);
    const { head } = await client.repoHead();
    throwIfAborted(signal);
    if (!head) return;
    await writer.syncFromHead(
      head.commitId,
      (commitId) => client.repoCommit(commitId),
      { batchSize: 100, signal },
    );
  };

  try {
    await run(preferred);
  } catch (error) {
    throwIfAborted(signal);
    if (!isDirectTransportIncompatible(error) || preferred === worker) throw error;
    await run(worker);
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('History indexing aborted', 'AbortError');
}
