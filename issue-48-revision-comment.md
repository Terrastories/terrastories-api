📝 **Issue Revised — Alignment and Clarity Updates**

I've revised the main issue to reflect the latest architecture and standards, and to tighten acceptance criteria.

Changes Applied:

- Switched authentication requirements from JWT to session-based auth (cookie sessions) to match current implementation.
- Added explicit requirement to apply rate limiting to `/api/v1/member/*` routes.
- Introduced DTO requirement for outbound responses and clarified the `{ data, meta }` envelope and error shape.
- Updated documentation references to current files (e.g., `docs/authentication-enhancement.md`).
- Clarified endpoint specs and permission matrix summaries; emphasized community isolation and ownership checks.
- Added Estimation section (8 story points; 3–4 days) and consolidated Definition of Done with coverage ≥80%.

Improvements:

- ✅ Clearer, SMART acceptance criteria and API standards
- ✅ Stronger security posture (sessions + rate limiting + DTOs)
- ✅ Better implementation guidance and testing scope
- ✅ Aligned with current repo configuration (Vitest coverage thresholds, session auth)

This issue should now be ready for implementation with reduced ambiguity and better guardrails.

---

_Revision completed via Codex CLI_
