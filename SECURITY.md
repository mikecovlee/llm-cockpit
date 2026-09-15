# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | ✅ |

## Reporting a vulnerability

Please report vulnerabilities privately via
**[GitHub Security Advisories](https://github.com/mikecovlee/llm-cockpit/security/advisories/new)**
("Report a vulnerability"). Do not open a public issue for security problems.

We aim to acknowledge within 7 days and ship a fix within 30 for anything
actionable, publishing a GHSA + patch release.

## Design posture (what is in scope)

LLM Cockpit is a **single-operator console for a trusted network**. It ships
with **no authentication** and binds `0.0.0.0` by default — this is an
explicit design decision, not a vulnerability, provided the network is
trusted (see README "Security"). Anyone who can reach the port can view
metrics, spend GPU time through the chat proxy, and make the server fetch
URLs supplied to `POST /api/validate-mapping`.

In scope for reports: XSS via the assistant-markdown rendering pipeline, path
traversal in asset serving, credential leakage (API keys in API responses or
logs), SSRF beyond the intended operator-configured set (e.g. via the
request body of `validate-mapping`), request-size DoS regressions, and similar.

Out of scope: the documented no-auth trusted-LAN model, and anything requiring
an attacker to already control the inference engine or the config file.
