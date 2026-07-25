# DNS plan — neulpumsec.com

Canonical host: https://www.neulpumsec.com (the apex 301-redirects to www)
Registrar/DNS: Cloudflare (proxying fully OFF — it conflicts with Vercel)

## Current

| Name   | Type  | Purpose             |
|--------|-------|---------------------|
| www    | CNAME | Vercel production   |
| @      | A     | → redirect to www   |

## Reserved (to be added per phase)

| Name                    | Phase | Purpose                          |
|-------------------------|-------|----------------------------------|
| clerk, accounts         | 2     | Clerk production instance        |
| clkmail, clk._domainkey | 2     | Clerk outbound mail              |
| send                    | 6     | Resend sending-only subdomain    |
| _dmarc                  | 6     | DMARC policy                     |

## Rules

- Attach Resend to the `send.` subdomain, not the apex
  → avoids conflicting with Cloudflare Email Routing's MX records

## TODO

- [ ] The apex A record still points at a legacy IP (76.76.21.21). It now only serves the
      redirect to www, but it still has to hold Vercel's current recommended value for that
      redirect to work. Check with: `npx vercel domains inspect neulpumsec.com`