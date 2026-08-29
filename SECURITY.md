# Security policy

## Supported version

Security fixes apply to the latest release on the `main` branch.

## Report a vulnerability

Use GitHub private vulnerability reporting when it is available. Do not open a public issue with an exploit or private data.

Include the affected version, operating system, reproduction steps, and impact. Remove database records, credentials, and private paths from the report.

## Security boundary

This server targets a trusted, single-user local environment. Scopes do not provide tenant isolation.

Use separate database files and process identities for separate security boundaries.
