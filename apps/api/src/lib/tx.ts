import type pg from 'pg';

/** A pool or a checked-out client: anything that can run a query. */
export type Db = pg.Pool | pg.PoolClient;

/**
 * Run `fn` in one READ COMMITTED transaction (the default isolation; ledger postings require it).
 * Rolls back on any error and always releases the client.
 */
export async function inTransaction<T>(
  pool: pg.Pool,
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
