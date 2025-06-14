import { Pool, type PoolClient } from 'pg';
import { logger } from '@elizaos/core';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';

export class PostgresConnectionManager {
  private pool: Pool;
  private db: NodePgDatabase;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
    this.db = drizzle(this.pool as any);
  }

  public getDatabase(): NodePgDatabase {
    return this.db;
  }

  public getConnection(): Pool {
    return this.pool;
  }

  public async getClient(): Promise<PoolClient> {
    return this.pool.connect();
  }

  public async testConnection(): Promise<boolean> {
    try {
      const client = await this.pool.connect();
      await client.query('SELECT 1');
      client.release();
      return true;
    } catch (error) {
      logger.error('Failed to connect to the database:', error);
      return false;
    }
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }
}
