import { sendMessage } from "@/lib/telegram/client";

import type { RenderedEvent } from "./events";

/**
 * Telegram as an outbound channel for events.
 *
 * The transport itself lives in lib/telegram/client, shared with the inbound
 * side; this module only decides that events go to the CEO chat.
 */
export async function sendTelegram(rendered: RenderedEvent): Promise<boolean> {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) return false;

  const messageId = await sendMessage(chatId, rendered.html, { silent: rendered.silent });
  return messageId !== null;
}
