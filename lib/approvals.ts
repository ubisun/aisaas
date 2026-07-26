import { enqueue } from "@/lib/queue";
import { createAdminClient } from "@/lib/supabase/admin";
import { editMessageText, sendMessage } from "@/lib/telegram/client";

/**
 * Human decisions, shared by every team.
 *
 * Requesting one is fire-and-forget: the caller describes what should happen
 * on each outcome and returns. Whenever the answer arrives -- from a Telegram
 * button or the dashboard -- the continuation is enqueued.
 */

export type Continuation = { path: string; body: Record<string, unknown> };

export type ApprovalRequest = {
  team: string;
  kind: string;
  runId?: string;
  /** One line. Plain text; renderers escape it. */
  title: string;
  /** The detail the decision rests on. Plain text. */
  body: string;
  onApprove?: Continuation;
  onReject?: Continuation;
  /** Defaults to 12 hours -- long enough to sleep on, short enough to matter. */
  ttlMinutes?: number;
};

export type Decision = "approved" | "rejected";

const DEFAULT_TTL_MINUTES = 12 * 60;

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function render(title: string, body: string): string {
  return `<b>🔔 ${escapeHtml(title)}</b>\n\n${escapeHtml(body)}`;
}

/**
 * Ask the CEO. Returns the approval id; the caller should then return, not
 * wait.
 */
export async function requestApproval(request: ApprovalRequest): Promise<string> {
  const supabase = createAdminClient();
  const expiresAt = new Date(
    Date.now() + (request.ttlMinutes ?? DEFAULT_TTL_MINUTES) * 60_000,
  );

  const { data, error } = await supabase
    .from("approvals")
    .insert({
      team: request.team,
      kind: request.kind,
      run_id: request.runId ?? null,
      title: request.title,
      body: request.body,
      on_approve: request.onApprove ?? null,
      on_reject: request.onReject ?? null,
      expires_at: expiresAt.toISOString(),
      telegram_chat_id: process.env.TELEGRAM_CHAT_ID ?? null,
    })
    .select("id")
    .single();

  if (error) throw new Error(`Requesting approval failed: ${error.message}`);
  const id = data.id as string;

  // Telegram is a convenience, not the system of record -- the approval exists
  // in the database either way and can be decided from the dashboard.
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (chatId) {
    try {
      const messageId = await sendMessage(chatId, render(request.title, request.body), {
        buttons: [
          [
            { text: "✅ Approve", callback_data: `approve:${id}` },
            { text: "❌ Reject", callback_data: `reject:${id}` },
          ],
        ],
      });
      // Stored so a decision made on the dashboard can retire the buttons in
      // the chat rather than leaving a live-looking message behind.
      if (messageId) {
        await supabase
          .from("approvals")
          .update({ telegram_message_id: messageId })
          .eq("id", id);
      }
    } catch (cause) {
      console.error("requestApproval: Telegram delivery failed", cause);
    }
  }

  return id;
}

export type DecisionResult =
  | { ok: true; approval: { id: string; title: string; team: string } }
  | { ok: false; reason: "not-found" | "already-decided" | "expired" };

/**
 * Record a decision and hand the continuation to the queue.
 *
 * The status update is conditional on the row still being pending, which is
 * what stops a Telegram button and the dashboard from both acting on the same
 * approval.
 */
export async function decideApproval(
  id: string,
  decision: Decision,
  via: "telegram" | "web",
): Promise<DecisionResult> {
  const supabase = createAdminClient();

  const { data: existing } = await supabase
    .from("approvals")
    .select(
      "id, team, title, status, expires_at, on_approve, on_reject, telegram_chat_id, telegram_message_id",
    )
    .eq("id", id)
    .maybeSingle();

  if (!existing) return { ok: false, reason: "not-found" };
  if (existing.status !== "pending") return { ok: false, reason: "already-decided" };

  if (new Date(existing.expires_at).getTime() < Date.now()) {
    await supabase.from("approvals").update({ status: "expired" }).eq("id", id).eq("status", "pending");
    return { ok: false, reason: "expired" };
  }

  // Compare-and-set: only the caller that flips it away from `pending` wins.
  const { data: claimed } = await supabase
    .from("approvals")
    .update({
      status: decision,
      decided_at: new Date().toISOString(),
      decided_via: via,
    })
    .eq("id", id)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();

  if (!claimed) return { ok: false, reason: "already-decided" };

  const continuation = (
    decision === "approved" ? existing.on_approve : existing.on_reject
  ) as Continuation | null;

  if (continuation?.path) {
    await enqueue(continuation.path, { ...continuation.body, approvalId: id, decision });
  }

  // Retire the chat message so the buttons cannot be pressed after the fact.
  // Best effort: the decision is already recorded and the continuation queued.
  const chatId = existing.telegram_chat_id as string | null;
  const messageId = existing.telegram_message_id as number | null;
  if (chatId && messageId) {
    try {
      await markTelegramDecided(chatId, messageId, existing.title as string, decision, via);
    } catch (cause) {
      console.error("decideApproval: could not edit the Telegram message", cause);
    }
  }

  return {
    ok: true,
    approval: { id, title: existing.title as string, team: existing.team as string },
  };
}

/** Rewrite the Telegram message so the buttons cannot be pressed again. */
export async function markTelegramDecided(
  chatId: string,
  messageId: number,
  title: string,
  decision: Decision,
  via: "telegram" | "web",
): Promise<void> {
  const mark = decision === "approved" ? "✅ Approved" : "❌ Rejected";
  await editMessageText(
    chatId,
    messageId,
    `<b>${escapeHtml(title)}</b>\n\n${mark}${via === "web" ? " (from the dashboard)" : ""}`,
  );
}

export type PendingApproval = {
  id: string;
  team: string;
  kind: string;
  title: string;
  body: string;
  /** Precomputed here rather than in the page: reading the clock during render
   *  is impure, and this is the layer that is allowed to. */
  hoursLeft: number;
};

export async function listPendingApprovals(): Promise<PendingApproval[]> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("approvals")
    .select("id, team, kind, title, body, requested_at, expires_at")
    .eq("status", "pending")
    .order("requested_at", { ascending: false })
    .limit(20);

  const now = Date.now();
  return (data ?? []).map((approval) => ({
    id: approval.id as string,
    team: approval.team as string,
    kind: approval.kind as string,
    title: approval.title as string,
    body: approval.body as string,
    hoursLeft: Math.max(
      0,
      Math.round((new Date(approval.expires_at as string).getTime() - now) / 3_600_000),
    ),
  }));
}
