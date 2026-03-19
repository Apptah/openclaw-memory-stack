## ADDED Requirements

### Requirement: CF Worker deployed and reachable
The license server Worker SHALL be deployed to Cloudflare and respond at `https://memory-stack.openclaw.dev/api/*`.

#### Scenario: API returns JSON for valid endpoint
- **WHEN** a POST request is sent to `https://memory-stack.openclaw.dev/api/activate` with valid JSON body
- **THEN** the server returns a JSON response with appropriate status code (200 or 403)

#### Scenario: API returns 404 for unknown endpoint
- **WHEN** a GET request is sent to `https://memory-stack.openclaw.dev/api/nonexistent`
- **THEN** the server returns HTTP 404 with JSON `{"error": "Not found"}`

### Requirement: CF Pages site deployed and reachable
The marketing site SHALL be deployed to Cloudflare Pages and serve HTML at `https://memory-stack.openclaw.dev/`.

#### Scenario: Landing page loads
- **WHEN** a browser navigates to `https://memory-stack.openclaw.dev/`
- **THEN** the page returns HTTP 200 with HTML content

#### Scenario: Thanks page loads
- **WHEN** a browser navigates to `https://memory-stack.openclaw.dev/thanks`
- **THEN** the page returns HTTP 200

#### Scenario: Manage page loads
- **WHEN** a browser navigates to `https://memory-stack.openclaw.dev/manage`
- **THEN** the page returns HTTP 200

### Requirement: Worker secrets configured
The Worker SHALL have all required secrets set: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, `ADMIN_TOKEN`.

#### Scenario: Checkout creates Stripe session
- **WHEN** a POST request is sent to `/api/checkout` with empty JSON body
- **THEN** the server returns HTTP 200 with a JSON body containing `checkout_url` pointing to `checkout.stripe.com`

### Requirement: R2 release artifact uploaded
The release tarball SHALL be available in the R2 bucket at key `v0.1.0/openclaw-memory-stack-v0.1.0.tar.gz`.

#### Scenario: Download with valid token returns tarball
- **WHEN** a GET request is sent to `/api/download/<valid-token>`
- **THEN** the server returns HTTP 200 with `Content-Type: application/gzip` and the tarball body

### Requirement: Resend domain verified
The sender domain `openclaw.dev` SHALL be verified in Resend so emails from `noreply@openclaw.dev` are delivered.

#### Scenario: Webhook sends email with verified domain
- **WHEN** a Stripe `checkout.session.completed` webhook fires
- **THEN** the email is sent from `noreply@openclaw.dev` (not `onboarding@resend.dev`)

### Requirement: Stripe webhook configured
The Stripe dashboard SHALL have a webhook endpoint pointing to `https://memory-stack.openclaw.dev/api/webhook` for `checkout.session.completed` events.

#### Scenario: Stripe delivers webhook to production
- **WHEN** a test payment completes in Stripe
- **THEN** the webhook is received and processed by the Worker (license created in KV)

### Requirement: DNS configured
`memory-stack.openclaw.dev` SHALL resolve to Cloudflare infrastructure.

#### Scenario: DNS resolution
- **WHEN** a DNS lookup is performed for `memory-stack.openclaw.dev`
- **THEN** it resolves to a Cloudflare IP or CNAME
