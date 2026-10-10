# Documentation

Start with the [quick start](../README.md#quick-start), then use the guide for your task.

| Guide | Contents |
| --- | --- |
| [Getting started](getting-started.md) | Install and register the server, connect clients, name sessions, send a first message. |
| [Configuration](configuration.md) | Config selection, required and optional fields, environment variables, database paths. |
| [Delivery](delivery.md) | Urgency, polling, tmux push, doorbell watcher, coalescing, and transport guarantees. |
| [Federation](federation.md) | Two-node setup, security boundary, remote delivery, and deployment templates. |
| [Operations](operations.md) | CLI reference, doctor, troubleshooting, upgrades, and retention. |
| [Compatibility and support](compatibility.md) | Current test evidence, tool and wire contracts, versioning, and release gates. |
| [Contributing](../CONTRIBUTING.md) | Development workflow, tests, and code conventions. |
| [Security reporting](../SECURITY.md) | Private vulnerability reporting. |
| [Changelog](../CHANGELOG.md) | Recorded changes. |

## Decisions and historical documents

[Decision 0001](decisions/0001-package-and-personal-deployment-boundary.md) records the accepted package and private-deployment boundary.

The documents under [superpowers/specs](superpowers/specs/) and [superpowers/plans](superpowers/plans/) are dated design and implementation records. They can contain proposals, old defaults, and work that has not shipped. Use the guides above and the current code for operating instructions. In particular, the [federation-auth design](superpowers/specs/2026-06-29-federation-auth-design.md) describes proposed authentication, not the current IP-allowlist implementation.
