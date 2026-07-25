<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# DocAI hard rules

These apply regardless of which tool is reading them. Do not write code that violates them.

1. **Clerk↔Supabase integration uses native Third-Party Auth only.**
   The JWT template / `supabaseAccessToken` approach was deprecated 2025-04-01 — never generate it.
   Always use the `createClient(url, anonKey, { accessToken })` pattern.
2. **Never prefix a secret with `NEXT_PUBLIC_`.**
   `SUPABASE_SERVICE_ROLE_KEY`, `CLERK_SECRET_KEY`, and `ANTHROPIC_API_KEY` are server-only.
3. **Never do PDF parsing or AI calls synchronously inside a request handler.**
   Hand the work to the queue and respond immediately.
4. **Every webhook handler verifies the signature and is idempotent.**
5. **Never guess at a library API.**
   Fetch `<vendor>/llms.txt` or the docs URL + `.md` to confirm.
   For Next.js, check `node_modules/next/dist/docs/` before fetching anything external.
