# Security Policy

## Reporting a vulnerability

Report privately through [GitHub Security Advisories](../../security/advisories/new) rather than
opening a public issue.

Expect an acknowledgement within 5 working days and an assessment within 10. If a fix is needed
we will agree a disclosure timeline with you, and credit you in the advisory unless you prefer
otherwise.

## What counts as a vulnerability here

Pheebs is a telemetry client that runs inside a coding agent, so the interesting failures are
about data leaving a machine when it should not:

- Any capture of content [`PRIVACY.md`](./PRIVACY.md) says is never captured — source, file
  paths, command strings, prompt text outside the documented classification path, or tool output.
- Any **event, prompt, or telemetry payload** transmitted when no backend endpoint is configured,
  or before consent is given. (The cached GitHub handle lookup and the once-a-day update check are
  known and expected — see [`PRIVACY.md`](./PRIVACY.md).)
- A token readable by another user on the machine, or leaking into a log, an event row, or an
  error message.
- Anything in `pheebs init` that writes outside the agent config files it declares, or that
  escalates what an installed hook can do.

Version support: only the latest release. Pheebs self-updates once a day by default.

## Scope

This policy covers the client in this repository. If you run your own backend, its security is
yours; the contract it implements is documented in
[`docs/backend-contract.md`](./docs/backend-contract.md).
