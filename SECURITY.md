# Security Policy

## Supported versions

Agent World is pre-1.0; security fixes land on the latest released version only.

## Reporting a vulnerability

**Please do not open a public issue for security reports.**

Use GitHub's private vulnerability reporting for this repository
("Security" tab → "Report a vulnerability"). Include:

- A description of the issue and its impact.
- Steps to reproduce or a proof of concept.
- Affected version/commit.

We aim to acknowledge reports within 5 business days and to coordinate a fix and
disclosure timeline with you.

## Scope & design notes

Agent World runs locally and binds only to `127.0.0.1`. Its threat model centers on:

- Not projecting raw worker credentials to the browser.
- Fail-closed session recovery and hash-chained audit events.
- Resistance to prompt-injection driven privilege escalation (a message's text
  cannot approve permissions, change policy, publish, or execute commands).

This is resistance to reward hacking, not a mathematical guarantee. Reports that
strengthen these properties are very welcome.
