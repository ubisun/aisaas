import { auth } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";

import { decideApproval, listPendingApprovals } from "@/lib/approvals";

/**
 * The other half of the approval gate. Telegram is the convenient path; this
 * is the one that still works when it is not to hand, and it shows the full
 * body rather than a chat-sized excerpt.
 */

async function decide(formData: FormData) {
  "use server";

  await auth.protect();

  const id = String(formData.get("id"));
  const decision = String(formData.get("decision"));
  if (decision !== "approved" && decision !== "rejected") return;

  await decideApproval(id, decision, "web");
  revalidatePath("/approvals");
}

export default async function ApprovalsPage() {
  await auth.protect();

  const pending = await listPendingApprovals();

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-12 font-sans">
      <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
        Waiting on you
      </h1>
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
        Decisions the company has deferred. Approving hands the work back to the
        queue; rejecting stops it.
      </p>

      {pending.length === 0 && (
        <p className="mt-8 rounded-lg border border-black/[.08] px-4 py-8 text-center text-sm text-zinc-500 dark:border-white/[.145] dark:text-zinc-400">
          Nothing waiting.
        </p>
      )}

      <div className="mt-8 flex flex-col gap-4">
        {pending.map((approval) => (
          <article
              key={approval.id}
              className="rounded-lg border border-black/[.08] p-5 dark:border-white/[.145]"
            >
              <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500 dark:text-zinc-500">
                <span className="rounded-full bg-zinc-100 px-2 py-0.5 font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                  {approval.team}
                </span>
                <span>{approval.kind}</span>
                <span>·</span>
                <span>{approval.hoursLeft}h left</span>
              </div>

              <h2 className="mt-3 text-base font-medium text-black dark:text-zinc-50">
                {approval.title}
              </h2>
              <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
                {approval.body}
              </p>

              <div className="mt-4 flex gap-2">
                <form action={decide}>
                  <input type="hidden" name="id" value={approval.id} />
                  <input type="hidden" name="decision" value="approved" />
                  <button
                    type="submit"
                    className="h-9 rounded-full bg-foreground px-4 text-sm font-medium text-background transition-colors hover:bg-[#383838] dark:hover:bg-[#ccc]"
                  >
                    Approve
                  </button>
                </form>
                <form action={decide}>
                  <input type="hidden" name="id" value={approval.id} />
                  <input type="hidden" name="decision" value="rejected" />
                  <button
                    type="submit"
                    className="h-9 rounded-full border border-black/[.08] px-4 text-sm font-medium text-zinc-700 transition-colors hover:bg-black/[.04] dark:border-white/[.145] dark:text-zinc-300 dark:hover:bg-[#1a1a1a]"
                  >
                    Reject
                  </button>
                </form>
              </div>
          </article>
        ))}
      </div>
    </main>
  );
}
