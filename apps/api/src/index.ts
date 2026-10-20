import { existsSync } from 'node:fs';
import { buildApp } from './app';
import { createPool } from './lib/db';
import { loadEnv, EnvError } from './lib/env';
import { createLogger } from './lib/logger';
import { systemClock } from '@barakah/shared';
import { createScheduler } from './jobs';
import { createSmsProvider } from './notifications/providers/sms';
import { ConsolePushSender, FcmPushSender } from './notifications/providers/push';

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL);
  const clock = systemClock;

  const pool = createPool(env.DATABASE_URL, {
    onError: (err) => logger.error({ err }, 'Idle database client error'),
  });

  const pushSender =
    env.FCM_SERVICE_ACCOUNT_JSON_PATH && existsSync(env.FCM_SERVICE_ACCOUNT_JSON_PATH)
      ? new FcmPushSender()
      : new ConsolePushSender(logger);

  const smsProvider = createSmsProvider(
    {
      provider: env.SMS_PROVIDER,
      httpUrl: env.SMS_HTTP_URL,
      apiKey: env.SMS_HTTP_API_KEY,
      senderId: env.SMS_SENDER_ID,
      bodyTemplate: env.SMS_HTTP_BODY_TEMPLATE,
    },
    logger,
  );

  const app = await buildApp({ env, db: pool, logger, clock, pushSender, smsProvider });

  const scheduler = createScheduler(env.DATABASE_URL, {
    env,
    pool,
    clock,
    log: logger,
    pushSender,
    smsProvider,
  });

  await app.listen({ port: env.PORT, host: env.HOST });
  await scheduler.start();
  logger.info(
    { port: env.PORT, host: env.HOST, version: env.APP_VERSION },
    'Barakah API started',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');
    try {
      await scheduler.stop();
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
