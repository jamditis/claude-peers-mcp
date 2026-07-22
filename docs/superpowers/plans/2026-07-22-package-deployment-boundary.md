# Package and personal deployment boundary implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superjawn:subagent-driven-development (recommended) or superjawn:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record where the public claude-peers package ends and a maintainer's private deployment begins, then make that decision discoverable from the README and GitHub roadmap.

**Architecture:** Keep the broker, protocol, tests, release process, and generic documentation in this repository. Treat private deployment as a package consumer whose machine-specific configuration, policies, service overrides, and secrets remain outside the public core.

**Tech stack:** Markdown, GitHub issues, Bun repository checks.

---

### Task 1: Record the decision

**Files:**
- Create: `docs/decisions/0001-package-and-personal-deployment-boundary.md`

- [ ] **Step 1: Write the decision record**

Document the accepted ownership boundary, package-consumer workflow, trigger for a future private deployment repository, change-routing rule, consequences, non-goals, and future-session pickup guide. State explicitly that the public core stays here, personal deployment consumes the npm package, and secrets remain in the credential vault.

- [ ] **Step 2: Check for private identifiers and prohibited attribution**

Run: `bun test tests/privacy.test.ts`

Expected: all privacy tests pass and the new document contains no private machine names, addresses, secret values, or AI attribution.

### Task 2: Make the decision discoverable

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Update: GitHub roadmap issue `#85`
- Comment: GitHub documentation issue `#74`

- [ ] **Step 1: Add a README boundary section**

Place a short section before Quick start that links the decision record and roadmap. Summarize the public-core, private-deployment, and credential-vault ownership rule without repeating the full decision.

- [ ] **Step 2: Add the boundary to the repository instructions**

Add the same concise ownership rule and pickup links near the top of `CLAUDE.md` so a new agent session sees the decision before package or deployment work.

- [ ] **Step 3: Update the roadmap**

Add a repository and deployment boundary section to issue `#85`. Preserve the research, milestones, dependency order, and npm gates already recorded there.

- [ ] **Step 4: Connect the documentation backlog**

Comment on issue `#74` with the pull request link and explain that the decision record defines the ownership boundary while `#74` still owns public setup, version, support-matrix, and upgrade accuracy.

### Task 3: Verify and publish

**Files:**
- Verify: all changed Markdown files

- [ ] **Step 1: Verify links and prose**

Run:

```bash
test -f docs/decisions/0001-package-and-personal-deployment-boundary.md
rg -n "Decision 0001|roadmap #85|private deployment" README.md CLAUDE.md docs/decisions/0001-package-and-personal-deployment-boundary.md
rg -n -i "[c]o-authored-by|[g]enerated by|[w]ritten by (ai|codex|claude)" README.md CLAUDE.md docs/decisions/0001-package-and-personal-deployment-boundary.md docs/superpowers/plans/2026-07-22-package-deployment-boundary.md && exit 1 || true
git diff --check
```

Expected: the decision file exists, both entry points are present, no attribution is found, and the diff check exits cleanly.

- [ ] **Step 2: Run repository checks**

Run sequentially:

```bash
bun test tests/privacy.test.ts
bun run typecheck
bun run lint
bun test --timeout 30000
```

Expected: every command exits 0.

- [ ] **Step 3: Run the local review gate**

Review the full diff against `origin/main`, fix actionable findings, and repeat until the documentation change converges within the repository's review-round cap.

- [ ] **Step 4: Publish the branch**

Commit only the decision record, implementation plan, README change, and repository-instruction change. Push the feature branch and open a draft pull request against `main`. Do not merge without explicit approval.
