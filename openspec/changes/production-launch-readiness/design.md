## Context

OpenClaw Memory Stack v0.1.0 is feature-complete. The server (CF Worker), site (Astro + CF Pages), installer, CLI, router, and 6 backend wrappers all work locally. Testing shows 18/31 commercial tests pass, 5 fail due to code bugs, 5 skip due to stub server constraints. The production domain `memory-stack.openclaw.dev` does not resolve — nothing is deployed yet.

Current infrastructure already provisioned:
- CF Worker project `openclaw-license` with KV namespace `f16c813bb53a44d495d7c1dc9e2278fe` and R2 bucket `openclaw-releases`
- Stripe product created (checkout creates sessions at $49)
- Resend account exists but sender domain unverified
- Release tarball built at `dist/openclaw-memory-stack-v0.1.0.tar.gz`

## Goals / Non-Goals

**Goals:**
- A customer can visit the site, pay $49, receive an email with license key + download link, install, and run queries — all working end-to-end
- All 31 commercial tests pass (0 failures)
- Production API responds correctly for all endpoints (activate, verify, checkout, webhook, download, reset-device, revoke)
- Monitoring: know when something breaks (Stripe webhook failures, email bounces)

**Non-Goals:**
- Linux validation (documented as "not fully validated" — fine for v0.1.0)
- Additional backends beyond the 6 already implemented
- Custom domain email (using openclaw.dev with Resend is sufficient)
- Analytics or usage tracking
- Auto-update mechanism

## Decisions

### D1: Deploy order — Worker first, then Pages
Deploy the license server Worker first because the site's checkout button calls `/api/checkout`. If Pages goes live before the Worker, visitors see a broken buy flow. Worker endpoints can return proper errors even without a site.

### D2: Stripe live mode keys
Switch from test keys to live keys. Create a new webhook endpoint in Stripe dashboard pointing to `https://memory-stack.openclaw.dev/api/webhook`. Both test and live webhook secrets must coexist during transition — use `wrangler secret put` for the live secret.

### D3: Resend domain verification
Verify `openclaw.dev` in Resend dashboard (add DNS TXT + DKIM records). The sender email `noreply@openclaw.dev` (already fixed in code) requires verified domain. Without this, emails go to spam or get rejected entirely.

### D4: CLI error fixes — minimal changes
The 3 empty error paths are caused by the CLI's `set -euo pipefail` exiting silently when a command in the error path itself fails. Fix by adding explicit error messages before the failing commands, not by restructuring the CLI.

### D5: R2 upload — manual via wrangler
Upload `dist/openclaw-memory-stack-v0.1.0.tar.gz` to R2 bucket at key `v0.1.0/openclaw-memory-stack-v0.1.0.tar.gz` using `wrangler r2 object put`. No need for automated CI upload at v0.1.0 scale.

## Risks / Trade-offs

- **[Stripe webhook race condition]** → Webhook fires before KV write propagates globally. Mitigation: KV is eventually consistent but CF edge-local writes are immediate; customer won't activate from a different continent within milliseconds.
- **[Email deliverability]** → First emails from new domain may have low reputation. Mitigation: Resend handles warm-up; volume is low enough (~tens of customers initially) that this is unlikely to trigger spam filters.
- **[Download token expiry]** → Webhook creates 24hr token; re-download creates 1hr token. If customer misses both windows, they must use /manage page. Mitigation: This is documented in quickstart and manage page exists.
- **[Single-region Worker]** → Worker runs at CF edge globally, but KV reads from nearest location. No risk for our scale.

## Migration Plan

1. **Verify Resend domain** — Add DNS records for `openclaw.dev` in Resend dashboard
2. **Set Worker secrets** — `wrangler secret put STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, `ADMIN_TOKEN`
3. **Deploy Worker** — `cd server && wrangler deploy`
4. **Configure DNS** — Point `memory-stack.openclaw.dev` to CF Worker (for API) and CF Pages (for site)
5. **Upload R2 artifact** — `wrangler r2 object put openclaw-releases/v0.1.0/openclaw-memory-stack-v0.1.0.tar.gz --file dist/openclaw-memory-stack-v0.1.0.tar.gz`
6. **Deploy Pages** — `cd site && wrangler pages deploy dist/`
7. **Configure Stripe webhook** — Add `https://memory-stack.openclaw.dev/api/webhook` endpoint in Stripe dashboard
8. **Smoke test** — Run the e2e production smoke test script
9. **Fix CLI bugs** — Apply 3 error message fixes, rebuild release tarball, re-upload

### Rollback
- Worker: `wrangler rollback` reverts to previous version
- Pages: CF Pages has automatic rollback to previous deployment
- Stripe: Disable webhook endpoint in dashboard
- DNS: Remove CNAME record
