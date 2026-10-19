# Security policy

This repository is a **fictional demonstration** (Bihar Cooperative Bank Ltd. does not exist). It holds no real customer data, and the public GitHub Pages demo stores data only in each visitor's own browser. Please never enter real personal data into it.

## Reporting a vulnerability

Please report security issues **privately** using GitHub's **"Report a vulnerability"** button on the repository's *Security* tab, not as a public issue. Reports are acknowledged within 7 days.

## Security design summary

* No third-party scripts, fonts or CDNs; strict Content-Security-Policy with Trusted Types.
* Optional (analytics / marketing) scripts are blocked until consent is recorded, and only allow-listed same-origin scripts can ever be activated.
* Server edition: AES-256-GCM encryption of personal data at rest, HMAC blind indexes, append-only HMAC-chained audit log, HttpOnly `SameSite=Strict` admin sessions, scrypt password hashing, rate limiting, Host-header allow-list, same-origin checks on writes.
* Privacy-friendly proof-of-work CAPTCHA (no third parties, single-use, signed, expiring) on account opening and admin sign-in.

See [README.md](README.md) for full details and the changes required before any real-world deployment.
