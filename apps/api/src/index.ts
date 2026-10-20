import { buildApp } from './app';
import { createPool } from './lib/db';
import { loadEnv, EnvError } from './lib/env';
import { createLogger } from './lib/logger';

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL);

  const pool = createPool(env.DATABASE_URL, {
    onError: (err) => logger.error({ err }, 'Idle database client error'),
  });
  const app = await buildApp({ env, db: pool, logger });

  await app.listen({ port: env.PORT, host: env.HOST });
  logger.info({ port: env.PORT, host: env.HOST, version: env.APP_VERSION }, 'Barakah API started');

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');
    try {
      await app.close();
      await pool.end();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Unhandled promise rejection');
  });
}

main().catch((err: unknown) => {
  if (err instanceof EnvError) {
    console.error(err.message);
  } else {
    console.error('Failed to start server:', err);
  }
  process.exit(1);
});
