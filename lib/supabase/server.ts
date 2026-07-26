import { auth } from "@clerk/nextjs/server";
import { createClient } from "@supabase/supabase-js";

/**
 * Read-side client for Server Components, authenticated as the signed-in Clerk
 * user so Supabase RLS applies.
 *
 * This is Clerk's native third-party auth integration: the session token is
 * handed to supabase-js through `accessToken`. The JWT-template /
 * `supabaseAccessToken` approach it replaced is deprecated -- see AGENTS.md.
 */
export function createServerSupabaseClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !publishableKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY are required",
    );
  }

  return createClient(url, publishableKey, {
    async accessToken() {
      return (await auth()).getToken();
    },
  });
}
