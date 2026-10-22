import { z } from 'zod';

/** Telegram bot tokens look like `123456789:AA...` (digits, a colon, 30+ URL-safe characters). */
export const telegramTokenSchema = z
  .string()
  .trim()
  .regex(/^\d{5,15}:[A-Za-z0-9_-]{30,60}$/);

export const telegramConnectSchema = z.object({ token: telegramTokenSchema });

export const telegramEnableSchema = z.object({ enabled: z.boolean() });

/** What the settings page may know. The token itself is never sent back. */
export interface TelegramStatus {
  connected: boolean;
  bot_username: string | null;
  linked: boolean;
  enabled: boolean;
}

export interface TelegramLinkCode {
  code: string;
  /** `https://t.me/<bot>?start=<code>`: one tap opens Telegram and sends the code. */
  link: string;
  expires_at: string;
}
