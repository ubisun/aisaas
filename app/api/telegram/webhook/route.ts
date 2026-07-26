import { runCommand } from "@/lib/telegram/commands";
import { sendMessage } from "@/lib/telegram/client";

/**
 * Inbound Telegram updates -- the CEO's way of asking the company something.
 *
 * Two checks stand between the internet and anything this can do:
 *
 *  1. The secret token Telegram echoes in a header, set when the webhook was
 *     registered. Without it, knowing the URL would be enough to issue
 *     commands (AGENTS.md rule 4).
 *  2. The chat the update came from. A valid signature only proves Telegram
 *     sent it -- the bot could have been added to someone else's chat.
 *
 * Always returns 200. Telegram retries non-2xx responses, and a retried
 * command is worse than a dropped one.
 */

type TelegramUpdate = {
  message?: {
    message_id: number;
    chat: { id: number };
    text?: string;
  };
};

export async function POST(request: Request) {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) {
    console.error("telegram webhook: TELEGRAM_WEBHOOK_SECRET is not set");
    return Response.json({ ok: true }, { status: 200 });
  }

  if (request.headers.get("x-telegram-bot-api-secret-token") !== expected) {
    // Not from Telegram, or from a webhook registered with a different
    // secret. 401 here rather than 200 -- there is no legitimate sender to
    // protect from retries.
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const update = (await request.json()) as TelegramUpdate;
  const message = update.message;
  if (!message?.text) return Response.json({ ok: true }, { status: 200 });

  const chatId = String(message.chat.id);
  if (chatId !== process.env.TELEGRAM_CHAT_ID) {
    console.warn(`telegram webhook: ignoring update from chat ${chatId}`);
    return Response.json({ ok: true }, { status: 200 });
  }

  const reply = await runCommand(message.text);
  if (reply) {
    await sendMessage(chatId, reply, { replyTo: message.message_id });
  }

  return Response.json({ ok: true }, { status: 200 });
}
