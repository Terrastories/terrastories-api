/**
 * Test Database Adapter for ActiveStorage Migration Tests
 *
 * Provides a proper interface between the ActiveStorage migrator service
 * and the test database, ensuring consistent data and proper transaction handling.
 */

import { TestDatabaseManager } from './database.js';

export interface DatabaseQuery {
  query(sql: string, params?: any[]): Promise<{ rows: any[] }>;
  connect(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Test adapter that integrates with the test database manager
 * to ensure migration tests use the same database instance as the test setup.
 */
export class ActiveStorageTestAdapter implements DatabaseQuery {
  private db: TestDatabaseManager;
  private transactionActive = false;
  public testAdapter = true; // Flag to identify this as a test adapter

  constructor(db: TestDatabaseManager) {
    this.db = db;
  }

  async connect(): Promise<void> {
    // Database is already connected through TestDatabaseManager
  }

  async close(): Promise<void> {
    // Database cleanup is handled by TestDatabaseManager
  }

  /**
   * Execute SQL query with proper parameter substitution and transaction handling
   */
  async query(sql: string, params?: any[]): Promise<{ rows: any[] }> {
    try {
      // Convert PostgreSQL-style parameters ($1, $2) to raw SQL for SQLite
      let query = sql;

      if (params && params.length > 0) {
        for (let i = 0; i < params.length; i++) {
          const placeholder = new RegExp(`\\$${i + 1}`, 'g');
          const value = params[i];

          let replacement: string;
          if (value === null || value === undefined) {
            replacement = 'NULL';
          } else if (typeof value === 'string') {
            // Escape single quotes and wrap in quotes
            replacement = `'${value.replace(/'/g, "''")}'`;
          } else if (typeof value === 'boolean') {
            replacement = value ? '1' : '0';
          } else {
            replacement = String(value);
          }

          query = query.replace(placeholder, replacement);
        }
      }

      // Handle transaction commands properly for SQLite
      const trimmedSql = sql.trim().toUpperCase();

      if (trimmedSql.startsWith('BEGIN')) {
        if (!this.transactionActive) {
          const result = await this.db.executeRaw(query);
          this.transactionActive = true;
          return { rows: [] };
        } else {
          // Transaction already active, return success
          return { rows: [] };
        }
      } else if (trimmedSql.startsWith('COMMIT')) {
        if (this.transactionActive) {
          const result = await this.db.executeRaw(query);
          this.transactionActive = false;
          return { rows: [] };
        } else {
          // No active transaction, return success
          return { rows: [] };
        }
      } else if (trimmedSql.startsWith('ROLLBACK')) {
        if (this.transactionActive) {
          const result = await this.db.executeRaw(query);
          this.transactionActive = false;
          return { rows: [] };
        } else {
          // No active transaction to rollback, return success
          console.warn('Attempted rollback with no active transaction');
          return { rows: [] };
        }
      }

      // Execute the query
      const result = await this.db.executeRaw(query);

      // Convert result to consistent format
      let rows: any[];
      if (Array.isArray(result)) {
        rows = result;
      } else if (result && typeof result === 'object') {
        rows = [result];
      } else {
        rows = [];
      }

      return { rows };
    } catch (error: any) {
      console.error('ActiveStorageTestAdapter query failed:', {
        sql: sql.substring(0, 200) + '...',
        params,
        error: error.message,
      });
      throw new Error(
        `Test database query failed: ${error.message}. Query: ${sql.substring(0, 100)}...`
      );
    }
  }

  /**
   * Reset transaction state (for test cleanup)
   */
  resetTransactionState(): void {
    this.transactionActive = false;
  }

  /**
   * Check if transaction is active
   */
  isTransactionActive(): boolean {
    return this.transactionActive;
  }
}
