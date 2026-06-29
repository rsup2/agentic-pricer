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
    // Keep the server-side session token refreshed in the background so an idle
    // connection isn't expired by Snowflake. Without this, a connection that
    // sits idle (overnight / low traffic) comes back as a terminated session and
    // throws "Unable to perform operation using terminated connection".
    clientSessionKeepAlive: true,
    clientSessionKeepAliveHeartbeatFrequency: 900, // seconds (min 900 / 15 min)
  },
  // generic-pool opts: cap connections so we don't exhaust Snowflake slots.
  {
    max: 10,
    min: 1,
    // Validate a connection before handing it out, and evict idle ones, so a
    // TCP-dropped or expired session is never reused. testOnBorrow runs
    // validate() (below) on acquire; the evictor sweeps the idle pool.
    testOnBorrow: true,
    evictionRunIntervalMillis: 60_000,
    idleTimeoutMillis: 300_000, // close connections idle > 5 min (NAT-drop window)
  },
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

/**
 * A pooled session can still die between validation and execution (TCP reset
 * mid-flight, server-side expiry). When that happens the SDK surfaces a
 * "terminated connection" error; the dead connection is destroyed on release,
 * so a single retry acquires a fresh one. Only retry on this class of error —
 * a genuine SQL error must surface, not loop.
 */
function isTerminatedConnectionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /terminated connection|not.* connected|session.* expired|terminated session/i.test(
    msg,
  );
}

async function withConnection<T>(fn: (conn: snowflake.Connection) => Promise<T>): Promise<T> {
  try {
    return await pool.use(fn);
  } catch (err) {
    if (!isTerminatedConnectionError(err)) throw err;
    // Retry once with a freshly acquired connection.
    return pool.use(fn);
  }
}

/** Run a read query and return rows. Acquires/releases a pooled connection. */
export async function executeQuery<T = Record<string, unknown>>(
  sqlText: string,
  binds: snowflake.Binds = [],
): Promise<T[]> {
  return withConnection((conn) => runOnConnection<T>(conn, sqlText, binds));
}

/** Run a write/DDL statement (insert, etc.). */
export async function executeWrite(
  sqlText: string,
  binds: snowflake.Binds = [],
): Promise<void> {
  await withConnection((conn) => runOnConnection(conn, sqlText, binds));
}

export async function drainPool(): Promise<void> {
  await pool.drain();
  await pool.clear();
}
