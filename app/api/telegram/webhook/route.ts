import { decideApproval } from "@/lib/approvals";
import { answerCallbackQuery, sendMessage } from "@/lib/telegram/client";
import { runCommand } from "@/lib/telegram/commands";

/**
 * Inbound Telegram updates -- the CEO's way of asking the company something,
 * and of answering when it asks back.
 *
 * Two checks stand between the internet and anything this can do:
 *
 *  1. The secret token Telegram echoes in a header, set when the webhook was
 *     registered. Without it, knowing the URL would be enough to issue
 *     commands and approve things (AGENTS.md rule 4).
 *  2. The chat the update came from. A valid signature only proves Telegram
 *     sent it -- the bot could have been added to someone else's chat.
 *
 * Always returns 200 past the signature check. Telegram retries non-2xx
 * responses, and a retried command is worse than a dropped one.
 */

type TelegramUpdate = {
  message?: {
    message_id: number;
    chat: { id: number };
    text?: string;
  };
  callback_query?: {
    id: string;
    data?: string;
    message?: { message_id: number; chat: { id: number } };
  };
};

const DECISION_REPLY = {
  approved: "Approved",
  rejected: "Rejected",
} as const;

async function handleCallback(query: NonNullable<TelegramUpdate["callback_query"]>) {
  const [action, id] = (query.data ?? "").split(":");
  if ((action !== "approve" && action !== "reject") || !id) {
    await answerCallbackQuery(query.id, "Unrecognised button");
    return;
  }

  const decision = action === "approve" ? "approved" : "rejected";
  const result = await decideApproval(id, decision, "telegram");

  if (result.ok) {
    await answerCallbackQuery(query.id, DECISION_REPLY[decision]);
    return;
  }

  const explanation = {
    "not-found": "That approval no longer exists",
    "already-decided": "Already decided",
    expired: "That approval expired",
  }[result.reason];

  await answerCallbackQuery(query.id, explanation);
}

export async function POST(request: Request) {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) {
    console.error("telegram webhook: TELEGRAM_WEBHOOK_SECRET is not set");
    return Response.json({ ok: true }, { status: 200 });
  }

  if (request.headers.get("x-telegram-bot-api-secret-token") !== expected) {
    // Not from Telegram, or from a webhook registered with a different
    // secret. 401 rather than 200 -- there is no legitimate sender to protect
    // from retries.
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const update = (await request.json()) as TelegramUpdate;
  const allowedChat = process.env.TELEGRAM_CHAT_ID;

  if (update.callback_query) {
    const chatId = String(update.callback_query.message?.chat.id ?? "");
    if (chatId !== allowedChat) {
      await answerCallbackQuery(update.callback_query.id, "Not permitted");
      return Response.json({ ok: true }, { status: 200 });
    }
    await handleCallback(update.callback_query);
    return Response.json({ ok: true }, { status: 200 });
  }

  const message = update.message;
  if (!message?.text) return Response.json({ ok: true }, { status: 200 });

  const chatId = String(message.chat.id);
  if (chatId !== allowedChat) {
    console.warn(`telegram webhook: ignoring update from chat ${chatId}`);
    return Response.json({ ok: true }, { status: 200 });
  }

  const reply = await runCommand(message.text);
  if (reply) {
    await sendMessage(chatId, reply, { replyTo: message.message_id });
  }

  return Response.json({ ok: true }, { status: 200 });
}
