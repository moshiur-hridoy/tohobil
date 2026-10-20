import pg from 'pg';

/** The slice of a database handle the app needs; lets tests pass a fake. */
export interface DbHandle {
  query(text: string): Promise<unknown>;
}

/**
 * Result type parsers, applied per pool (not globally):
 *  - int8 (bigint) -> BigInt: money is bigint paisa end to end, never a lossy JS number.
 *  - date -> the raw 'YYYY-MM-DD' string: node-pg would otherwise build a Date at local midnight,
 *    which shifts business dates by the machine's time zone.
 */
const types = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    if (oid === 20) return (value: string) => BigInt(value);
    if (oid === 1082) return (value: string) => value;
    return pg.types.getTypeParser(oid, format as 'text');
  },
};

export interface PoolOptions {
  max?: number;
  onError?: (err: Error) => void;
}

/**
 * Create the connection pool. Postgres runs with max_connections=20 (spec 12) shared with pg-boss
 * and the migrator, so the pool stays small.
 */
export function createPool(connectionString: string, opts: PoolOptions = {}): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max: opts.max ?? 8,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: 'barakah-api',
    types,
  });
  // An idle client can error (e.g. the database restarts). Without a listener Node would crash.
  pool.on('error', (err) => opts.onError?.(err));
  return pool;
}
