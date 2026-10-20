import { createLogger } from '../../lib/logger';
import {
  sendQueuedNotifications as sendAll,
  runSmsFallback as fallback,
  type NotificationDeps,
} from '../../notifications/service';
import type { JobDeps } from '../index';

export function makeNotificationDeps(deps: JobDeps): NotificationDeps {
  return {
    pool: deps.pool,
    clock: deps.clock,
    log: createLogger(deps.env.LOG_LEVEL),
    pushSender: deps.pushSender,
    smsProvider: deps.smsProvider,
  };
}

export async function sendQueuedNotifications(deps: JobDeps): Promise<number> {
  return sendAll(makeNotificationDeps(deps));
}

export async function runSmsFallback(deps: JobDeps): Promise<number> {
  return fallback(makeNotificationDeps(deps));
}
