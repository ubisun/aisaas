import { Client } from "@upstash/qstash";

/**
 * Hand work to QStash.
 *
 * Every step of the pipeline that would outlive a request handler goes
 * through here, which is also what keeps each Vercel function inside the
 * 60s ceiling on the Hobby plan.
 */
export async function enqueue(path: string, body: unknown): Promise<void> {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) throw new Error("NEXT_PUBLIC_APP_URL is not set");

  const token = process.env.QSTASH_TOKEN;
  if (!token) throw new Error("QSTASH_TOKEN is not set");

  const client = new Client({ token });
  await client.publishJSON({ url: `${appUrl.replace(/\/$/, "")}${path}`, body });
}
