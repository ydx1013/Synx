import { FifoSerializer } from './fifoSerializer.js';
import type { RepositoryClient } from './repositoryClient.js';

export class RepositoryWriteCoordinator {
  private readonly serializer = new FifoSerializer();

  constructor(private readonly selectClient: () => Promise<RepositoryClient>) {}

  run<T>(operation: (client: RepositoryClient) => Promise<T>): Promise<T> {
    return this.serializer.run(async () => operation(await this.selectClient()));
  }

  runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    return this.serializer.run(operation);
  }
}
