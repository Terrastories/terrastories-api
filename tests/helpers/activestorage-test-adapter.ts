/**
 * ActiveStorage Test Database Adapter
 *
 * Bridges TestDatabaseManager with ActiveStorage migrator for unified database access
 */

import { TestDatabaseManager } from './database.js';
import type { DatabaseQuery } from '../../src/services/activestorage-migrator.js';

/**
 * Test database adapter that uses TestDatabaseManager's database instance
 */
export class ActiveStorageTestAdapter implements DatabaseQuery {
  private testDb: TestDatabaseManager;
  public testAdapter = true; // Mark as test adapter

  constructor(testDb: TestDatabaseManager) {
    this.testDb = testDb;
  }

  async query(sql: string, params?: any[]): Promise<{ rows: any[] }> {
    // Convert parameterized queries to SQLite format
    let finalSql = sql;
    if (params && params.length > 0) {
      // Replace PostgreSQL-style $1, $2, etc. with actual values for SQLite
      for (let i = 0; i < params.length; i++) {
        const placeholder = new RegExp(`\\$${i + 1}`, 'g');
        if (params[i] === null) {
          finalSql = finalSql.replace(placeholder, 'NULL');
        } else if (typeof params[i] === 'string') {
          finalSql = finalSql.replace(
            placeholder,
            `'${params[i].replace(/'/g, "''")}'`
          );
        } else if (params[i] instanceof Date) {
          finalSql = finalSql.replace(
            placeholder,
            `'${params[i].toISOString()}'`
          );
        } else {
          finalSql = finalSql.replace(placeholder, String(params[i]));
        }
      }
    }

    try {
      const result = await this.testDb.executeRaw(finalSql);
      const rows = Array.isArray(result) ? result : result ? [result] : [];

      // Debug complex queries
      if (
        process.env.NODE_ENV === 'test' &&
        finalSql.includes('active_storage_attachments') &&
        finalSql.includes('JOIN')
      ) {
        console.log('Complex migration query:', finalSql);
        console.log('Query result rows:', rows.length);
        if (rows.length > 0) {
          console.log('First row:', rows[0]);
        }
      }

      return { rows };
    } catch (error: any) {
      console.error('ActiveStorage test adapter query failed:', {
        sql: finalSql,
        originalSql: sql,
        params,
        error: error.message,
      });
      throw error;
    }
  }

  async connect(): Promise<void> {
    // TestDatabaseManager handles connection setup
    await this.testDb.setup();
  }

  async close(): Promise<void> {
    // TestDatabaseManager handles cleanup
    // No need to close here as tests may reuse the connection
  }
}
