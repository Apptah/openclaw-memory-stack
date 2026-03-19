# TODOS — OpenClaw Memory Stack

## Post-Launch

### TODO: CORS Hardening
**Priority:** P3 | **Effort:** S (< 1 hour) | **Depends on:** Pages deployment complete

Restrict API CORS from `Access-Control-Allow-Origin: *` to only allow the Pages domain. Currently any website can make cross-origin requests to the license API. Low risk since all operations require a license key, but overly permissive CORS is a bad practice.

**Where:** `server/src/index.ts` — the CORS headers block
**What to do:** Replace `*` with the actual Pages `.pages.dev` URL. When a custom domain is added later, update to that.

---

### TODO: CLAUDE.md Project Documentation
**Priority:** P2 | **Effort:** S (< 1 hour) | **Depends on:** None

Create CLAUDE.md documenting project conventions, test commands, deployment workflow, and architecture decisions. This helps Claude Code assist more effectively in future sessions without re-exploring the project structure.

**Should include:**
- Project structure overview (CLI bash, server TypeScript CF Worker, site Astro)
- Test commands (`cd server && bun test`, commercial tests, integration tests)
- Deployment commands (wrangler deploy, pages deploy)
- Key architecture decisions (KV for licenses, R2 for releases, rule-based routing)

---

### TODO: Complete Server Handler Tests
**Priority:** P2 | **Effort:** M (2-4 hours) | **Depends on:** webhook + activate tests (11A) complete

Add unit tests for the remaining 5 server handlers: checkout, verify, download, reset-device, revoke. Currently only webhook and activate have tests. The other handlers' edge cases are only covered by the production smoke test.

**Where:** `server/src/__tests__/handlers.test.ts` (extend existing file)
**Key scenarios to cover:**
- checkout: Stripe session creation, error handling
- verify: rate limiting (already wired), valid/invalid/revoked license, device match
- download: token validation, one-time use, R2 artifact retrieval
- reset-device: email match, monthly limit, device removal
- revoke: admin token auth, license deactivation
