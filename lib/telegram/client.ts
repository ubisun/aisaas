/**
 * Low-level Telegram Bot API calls.
 *
 * Both directions share this: outbound event notifications (lib/notify) and
 * replies to inbound commands.
 */

export type InlineButton = {
  text: string;
  /** Sent back as `callback_query.data` when pressed. Max 64 bytes. */
  callback_data: string;
};

export type SendOptions = {
  /** Suppresses the notification sound; the message still arrives. */
  silent?: boolean;
  /** Rows of buttons attached under the message. */
  buttons?: InlineButton[][];
  /** Reply to a specific message rather than posting standalone. */
  replyTo?: number;
};

function botToken(): string | undefined {
  return process.env.TELEGRAM_BOT_TOKEN;
}

function api(method: string): string {
  return `https://api.telegram.org/bot${botToken()}/${method}`;
}

/**
 * Send a message.
 *
 * Returns the new message's id, or null when the bot is unconfigured -- an
 * absent bot is not an error, so a deployment without Telegram credentials
 * still runs. The id is what lets a message be edited later, e.g. to retire
 * approval buttons once the decision is made elsewhere.
 */
export async function sendMessage(
  chatId: string,
  html: string,
  options: SendOptions = {},
): Promise<number | null> {
  if (!botToken() || !chatId) return null;

  const response = await fetch(api("sendMessage"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: html,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      disable_notification: options.silent ?? false,
      ...(options.replyTo ? { reply_parameters: { message_id: options.replyTo } } : {}),
      ...(options.buttons ? { reply_markup: { inline_keyboard: options.buttons } } : {}),
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram sendMessage returned ${response.status}: ${body.slice(0, 200)}`);
  }

  const payload = (await response.json()) as { result?: { message_id?: number } };
  return payload.result?.message_id ?? null;
}

/**
 * Acknowledge a button press. Telegram shows a loading spinner on the button
 * until this is called, so it should happen even when the action fails.
 */
export async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  if (!botToken()) return;

  await fetch(api("answerCallbackQuery"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text: text?.slice(0, 200) }),
  });
}

/** Replace the text of a message already sent, e.g. after a button is used. */
export async function editMessageText(
  chatId: string,
  messageId: number,
  html: string,
): Promise<void> {
  if (!botToken()) return;

  await fetch(api("editMessageText"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text: html,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    }),
  });
}
