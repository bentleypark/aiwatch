# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in AIWatch, please report it responsibly:

1. **GitHub Security Advisory** (preferred): [Report a vulnerability](https://github.com/bentleypark/aiwatch/security/advisories/new)
2. **Public issue**: If the vulnerability is not sensitive, open a [GitHub issue](https://github.com/bentleypark/aiwatch/issues/new) with the `security` label

**Please do NOT open a public issue for sensitive security vulnerabilities.**

## Response Timeline

- **Acknowledgement**: within 48 hours
- **Initial assessment**: within 7 days
- **Fix or mitigation**: depends on severity, typically within 30 days

## Scope

The following areas are in scope for security reports:

- **Worker endpoints** (`/api/status`, `/api/alert`, `/api/vitals`, `/api/v1/*`) — injection, CORS bypass, data exposure
- **Status page parsers** (`worker/src/parsers/`) — XML/HTML injection, SSRF via crafted status page responses
- **Frontend** (`src/`) — XSS, open redirects, sensitive data in client storage
- **Edge Functions** (`api/`) — SSR injection, header manipulation
- **Webhook proxy** (`/api/alert`) — relay abuse, payload injection

## Out of Scope

- Rate limiting on the Cloudflare Worker (platform-level concern)
- Denial of service against third-party status pages we monitor
- Social engineering attacks
- Vulnerabilities in dependencies with no demonstrated impact on AIWatch

## Acknowledgements

We appreciate responsible disclosure and will credit reporters in the fix commit (with permission).
