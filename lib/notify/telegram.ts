import type { RenderedEvent } from "./events";

/**
 * Telegram Bot API transport.
 *
 * Returns false rather than throwing when the bot is not configured, so a
 * deployment without Telegram credentials still runs the pipeline.
 */
export async function sendTelegram(rendered: RenderedEvent): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: rendered.html,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      disable_notification: rendered.silent ?? false,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram API returned ${response.status}: ${body.slice(0, 200)}`);
  }
  return true;
}
