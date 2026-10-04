# Security policy

Trickle stores OAuth tokens that can send email as you, so security reports are taken seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private vulnerability reporting (the repository's **Security → Report a vulnerability** tab). Include steps to reproduce and the version or commit you tested.

You should get an acknowledgement within a few days. Once a fix is released, the report is credited in the release notes unless you'd rather stay anonymous.

## Hardening checklist for operators

- Generate every secret with `node scripts/init-env.mjs` or `openssl rand -hex 32`; never reuse the examples.
- Serve the app over HTTPS (`docker compose --profile https up -d`, or your own proxy).
- Keep Postgres and Redis off the public internet. The bundled compose file never publishes them.
- Restrict sign-in to specific addresses in `ALLOWED_LOGIN_EMAILS`, and use a long `ADMIN_PASSWORD` if you enable it.
- Back up `.env` securely. `TOKEN_ENCRYPTION_KEY` decrypts the stored Gmail tokens.
- If a session cookie leaks, rotate `SESSION_SECRET` (signs everyone out). Don't rotate `TRACKING_SECRET` once you've sent mail.
