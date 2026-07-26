import { Client } from "@upstash/qstash";

/**
 * Hand work to QStash.
 *
 * Every step of the pipeline that would outlive a request handler goes
 * through here, which is also what keeps each Vercel function inside the
 * 60s ceiling on the Hobby plan.
 */

export const FAILURE_CALLBACK_PATH = "/api/jobs/failure";

function appUrl(): string {
  const base = process.env.NEXT_PUBLIC_APP_URL;
  if (!base) throw new Error("NEXT_PUBLIC_APP_URL is not set");
  return base.replace(/\/$/, "");
}

export async function enqueue(path: string, body: unknown): Promise<void> {
  const token = process.env.QSTASH_TOKEN;
  if (!token) throw new Error("QSTASH_TOKEN is not set");

  const client = new Client({ token });
  await client.publishJSON({
    url: `${appUrl()}${path}`,
    body,
    // Without this, a step that is killed rather than throwing -- a function
    // timeout -- fails silently: the handler never reaches its catch block, so
    // nothing marks the run failed and nothing tells anyone. QStash calls this
    // once its retries are exhausted, which is the only moment the failure is
    // observable from outside the dead process.
    failureCallback: `${appUrl()}${FAILURE_CALLBACK_PATH}`,
  });
}
