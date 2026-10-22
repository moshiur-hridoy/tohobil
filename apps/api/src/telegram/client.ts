/** The few Telegram Bot API calls this app needs, behind an interface so tests can fake them. */

export type InlineKeyboard = { text: string; callback_data: string }[][];

export interface TelegramApi {
  getMe(token: string): Promise<{ username: string }>;
  setWebhook(token: string, url: string, secret: string): Promise<void>;
  deleteWebhook(token: string): Promise<void>;
  sendMessage(token: string, chatId: string, html: string, keyboard?: InlineKeyboard): Promise<void>;
  editMessage(
    token: string,
    chatId: string,
    messageId: number,
    html: string,
    keyboard?: InlineKeyboard,
  ): Promise<void>;
  answerCallback(token: string, callbackId: string, text?: string): Promise<void>;
}

/** Telegram refused a call; `description` is its own English text, shown to the cashier on the settings page. */
export class TelegramError extends Error {
  constructor(readonly description: string) {
    super(`Telegram: ${description}`);
    this.name = 'TelegramError';
  }
}

const TIMEOUT_MS = 10_000;

async function call<T>(token: string, method: string, body: Record<string, unknown>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // Never echo the underlying error: its URL contains the bot token.
    throw new TelegramError('could not reach Telegram');
  }
  const json = (await res.json().catch(() => null)) as
    | { ok: boolean; result?: T; description?: string }
    | null;
  if (!json?.ok) throw new TelegramError(json?.description ?? `HTTP ${res.status}`);
  return json.result as T;
}

const markup = (keyboard?: InlineKeyboard) =>
  keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {};

export const httpTelegramApi: TelegramApi = {
  async getMe(token) {
    const me = await call<{ username?: string }>(token, 'getMe', {});
    return { username: me.username ?? '' };
  },
  async setWebhook(token, url, secret) {
    await call(token, 'setWebhook', {
      url,
      secret_token: secret,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: true,
    });
  },
  async deleteWebhook(token) {
    await call(token, 'deleteWebhook', { drop_pending_updates: true });
  },
  async sendMessage(token, chatId, html, keyboard) {
    await call(token, 'sendMessage', {
      chat_id: chatId,
      text: html,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...markup(keyboard),
    });
  },
  async editMessage(token, chatId, messageId, html, keyboard) {
    await call(token, 'editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: html,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      // An empty keyboard removes the buttons.
      reply_markup: { inline_keyboard: keyboard ?? [] },
    });
  },
  async answerCallback(token, callbackId, text) {
    await call(token, 'answerCallbackQuery', { callback_query_id: callbackId, ...(text ? { text } : {}) });
  },
};
