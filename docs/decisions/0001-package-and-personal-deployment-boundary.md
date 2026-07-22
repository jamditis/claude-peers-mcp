# Decision 0001: Separate the public package from personal deployment

- Status: Accepted
- Date: 2026-07-22
- Roadmap: [#85](https://github.com/jamditis/claude-peers-mcp/issues/85)

## Context

Claude-peers began as software used directly from a source checkout. The project is now preparing for a public npm beta, while its maintainer also depends on it as part of a personal, multi-machine working system.

Those uses need different ownership boundaries. The public project needs portable code, generic configuration, tested installation, and a stable compatibility contract. A personal deployment needs machine addresses, service definitions, role names, protected-session policy, local hooks, and an upgrade schedule. Combining both in this repository would expose private operating details and make the package appear to support assumptions that belong to one deployment. Creating a second copy of the core would split its roadmap, tests, issue history, and fixes.

## Decision

The current `claude-peers-mcp` repository remains the canonical source for the reusable product and the package published as `claude-peers-mcp`.

Personal use will consume the same released package as any other installation. It will not use a private fork or a second core repository. Operator-specific deployment material will live outside this repository when it becomes substantial enough to version independently.

The ownership boundary is:

| Concern | Owner |
| --- | --- |
| Broker, protocol, MCP tools, CLI, generic configuration schema, tests, portable service examples, release automation, and package documentation | This repository |
| Machine inventory, real addresses, role names, local policy, service overrides, package-version pins, rollout sequencing, and private automation | A private deployment layer |
| Descriptive fleet knowledge and operational history | The private fleet atlas |
| Tokens, signing keys, credentials, and other secret values | The credential vault |

## Package-consumer workflow

The maintainer's own deployment is the first serious package consumer. It follows the public path instead of relying permanently on a source checkout:

1. During development, run the current checkout to test changes before release.
2. During public beta, install an exact prerelease published under the npm `next` tag.
3. After a beta version is accepted, pin the deployment to that exact version.
4. Upgrade deliberately after verification. Fleet automation must not follow an unbounded `latest` tag.
5. If personal use exposes a generally useful defect or capability, fix it here and release it through the same package path.

This workflow is part of the beta evidence. A package that only works from the maintainer's checkout has not passed the installability gate.

## When to create a private deployment repository

Do not create a new repository merely to detach development from personal use. Create a small private deployment repository when there are executable artifacts that need their own history, such as:

- service definitions or per-platform launch wrappers;
- sanitized configuration templates plus private overlays;
- bootstrap and upgrade scripts for multiple machines;
- exact package-version pins and rollback instructions;
- local hooks or policy that would be inappropriate as public defaults.

The private deployment repository must consume the npm package. It must not copy the broker, maintain a long-lived source fork, or become a second place for generic product fixes. The private fleet atlas remains documentation rather than the executable deployment artifact.

## Change-routing rule

Use this test before opening an issue or changing a file:

- If the change would help an unrelated claude-peers user, it belongs in this repository.
- If the change only describes or operates one person's machines and working practices, it belongs in the private deployment layer.
- If the value is sensitive, it belongs in the credential vault and is referenced only by a non-secret pointer.
- If a deployment-specific failure reveals a generic product defect, reproduce and fix the defect in this repository.

## Consequences

- The roadmap, tests, releases, user feedback, and package history remain together.
- The maintainer dogfoods the published artifact and exercises the same clean-install path as other users.
- Public documentation can include portable deployment examples without carrying real fleet details.
- Personal rollout policy can change independently of the package release cadence.
- A private deployment repository may be added later, but it is not a prerequisite for the current reliability, federation, or identity milestones.

## Explicit non-goals

- Do not move the npm roadmap into another repository.
- Do not publish operator-specific configuration, addresses, role names, or secrets here.
- Do not add one deployment's policy as a package default unless independent users need the same behavior.
- Do not create a second package or private core fork to support the maintainer's installation.

## Pickup guide for a future session

Before package or deployment work:

1. Read [roadmap #85](https://github.com/jamditis/claude-peers-mcp/issues/85) and this decision.
2. Identify the active milestone and its epic before selecting a child issue.
3. Keep npm publication gated behind the reliability, federation, and identity milestones.
4. During the public-beta milestone, test an exact prerelease as an external consumer.
5. Create the private deployment repository only if the executable-artifact trigger above has been reached.

Related work: [#35](https://github.com/jamditis/claude-peers-mcp/issues/35), [#74](https://github.com/jamditis/claude-peers-mcp/issues/74), [#76](https://github.com/jamditis/claude-peers-mcp/issues/76), and [#82](https://github.com/jamditis/claude-peers-mcp/issues/82).
