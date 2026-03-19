## Why

OpenClaw Memory Stack is feature-complete but cannot accept real customers yet. Comprehensive testing revealed 3 blockers: the production domain (`memory-stack.openclaw.dev`) does not resolve, the email sender uses Resend's sandbox domain, and 3 CLI error paths return empty output instead of user-facing messages. Additionally, the Stripe checkout flow has never been tested end-to-end in production mode. This change fixes all blockers and validates the full purchase-to-query pipeline so we can launch.

## What Changes

- Deploy CF Worker (license server) and CF Pages (marketing site) to production with DNS configured
- Verify Resend sender domain (`openclaw.dev`) and confirm delivery
- Fix 3 CLI error paths that return empty output: unavailable backend, duplicate embed, and revoked license re-verify
- Upload v0.1.0 release tarball to R2 bucket
- Run full E2E production smoke test: Stripe checkout -> webhook -> email -> download -> install -> activate -> init -> query -> verify -> device reset
- Fix 5 commercial test failures (1 cosmetic, 2 error UX, 1 verify flow, 1 outdated test)
- Configure Stripe webhook endpoint to point to production Worker URL
- Set all CF Worker secrets (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, RESEND_API_KEY, ADMIN_TOKEN)

## Capabilities

### New Capabilities
- `production-deployment`: CF Worker + Pages deployment, DNS, secrets, R2 release upload
- `cli-error-messages`: Fix empty error output for 3 CLI error paths
- `e2e-smoke-test`: Full production purchase-to-query validation script

### Modified Capabilities
<!-- No existing specs to modify -->

## Impact

- **Server**: `server/src/webhook.ts` (sender email already fixed), `wrangler.toml` (may need route config)
- **CLI**: `bin/openclaw-memory` (error message fixes)
- **Tests**: `tests/commercial/test-backend-unavailable.sh`, `test-embed-bg-duplicate.sh`, `test-reverify-revoked.sh`, `test-license-valid.sh`, `test-runtime-starter-only.sh`
- **Infrastructure**: Cloudflare DNS, Worker secrets, Stripe webhook config, Resend domain verification, R2 bucket upload
- **Dependencies**: None new — all existing (CF, Stripe, Resend)
