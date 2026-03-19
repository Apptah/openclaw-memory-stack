## ADDED Requirements

### Requirement: Production smoke test script
A script SHALL exist at `tests/integration/test-production-smoke.sh` that validates the full purchase-to-query pipeline against the live production environment.

#### Scenario: Full E2E pipeline
- **WHEN** the smoke test script is run with `OPENCLAW_TEST_LIVE=1`
- **THEN** it validates each stage of the pipeline and reports pass/fail per stage

### Requirement: API endpoint validation
The smoke test SHALL validate all production API endpoints return correct responses.

#### Scenario: Activate with invalid key
- **WHEN** `/api/activate` is called with an invalid license key
- **THEN** the response is HTTP 403 with `{"valid": false, "reason": "invalid_key"}`

#### Scenario: Verify with invalid key
- **WHEN** `/api/verify` is called with an invalid license key
- **THEN** the response is HTTP 403 with `{"valid": false, "reason": "invalid_key"}`

#### Scenario: Checkout returns Stripe URL
- **WHEN** `/api/checkout` is called
- **THEN** the response is HTTP 200 with a `checkout_url` containing `checkout.stripe.com`

#### Scenario: Download with expired token
- **WHEN** `/api/download/<expired-token>` is called
- **THEN** the response is HTTP 404 with error message

### Requirement: Site page validation
The smoke test SHALL validate all customer-facing pages return HTTP 200.

#### Scenario: All pages reachable
- **WHEN** the smoke test checks `/`, `/thanks`, `/manage`
- **THEN** all return HTTP 200

### Requirement: Commercial test suite passes
All 31 commercial tests SHALL pass with 0 failures.

#### Scenario: Full commercial test run
- **WHEN** the commercial test suite is run
- **THEN** all tests pass (0 failures, 0 skips due to code bugs)
