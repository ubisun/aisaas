import { render, type AppEvent } from "./events";
import { sendTelegram } from "./telegram";

export type { AppEvent } from "./events";

/**
 * Deliver an event to every configured channel.
 *
 * Notification is never allowed to fail the work that produced the event --
 * a report that was generated and stored is still a success even if Telegram
 * is down. Failures are logged and swallowed.
 *
 * Adding a second channel (email, Slack) means adding a transport module and
 * another entry here; the event types and their rendering stay untouched.
 */
export async function notify(event: AppEvent): Promise<void> {
  const rendered = render(event);

  const results = await Promise.allSettled([sendTelegram(rendered)]);

  for (const result of results) {
    if (result.status === "rejected") {
      console.error(`notify(${event.type}) failed:`, result.reason);
    }
  }
}
