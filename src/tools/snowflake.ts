import snowflake from 'snowflake-sdk';
import { env } from '../env.js';

/**
 * Pooled Snowflake access. Concurrent pricing runs share a connection pool
 * rather than opening a session per query — important under spiky traffic.
 *
 * snowflake-sdk is callback-based; we wrap the pool's use() in a promise.
 */

snowflake.configure({ logLevel: 'ERROR' });

const pool = snowflake.createPool(
  {
    account: env.SNOWFLAKE_ACCOUNT,
    username: env.SNOWFLAKE_USER,
    password: env.SNOWFLAKE_PASSWORD,
    warehouse: env.SNOWFLAKE_WAREHOUSE,
    role: env.SNOWFLAKE_ROLE,
    database: env.SNOWFLAKE_DATABASE,
    schema: env.SNOWFLAKE_SCHEMA,
  },
  // generic-pool opts: cap connections so we don't exhaust Snowflake slots.
  { max: 10, min: 1 },
);

function runOnConnection<T = Record<string, unknown>>(
  conn: snowflake.Connection,
  sqlText: string,
  binds: snowflake.Binds = [],
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText,
      binds,
      complete: (err, _stmt, rows) => {
        if (err) reject(err);
        else resolve((rows ?? []) as T[]);
      },
    });
  });
}

/** Run a read query and return rows. Acquires/releases a pooled connection. */
export async function executeQuery<T = Record<string, unknown>>(
  sqlText: string,
  binds: snowflake.Binds = [],
): Promise<T[]> {
  return pool.use((conn) => runOnConnection<T>(conn, sqlText, binds));
}

/** Run a write/DDL statement (insert, etc.). */
export async function executeWrite(
  sqlText: string,
  binds: snowflake.Binds = [],
): Promise<void> {
  await pool.use((conn) => runOnConnection(conn, sqlText, binds));
}

export async function drainPool(): Promise<void> {
  await pool.drain();
  await pool.clear();
}
