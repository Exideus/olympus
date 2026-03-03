# OLYMPUS — Product Roadmap

> **OLYMPUS** is an AI agent orchestration platform that coordinates a squad of specialized AI agents to autonomously plan, code, review, test, document, and ship software — across multiple external client projects simultaneously.

Built on Supabase, Deno edge functions, React, and a dedicated execution server (GMK), OLYMPUS replaces the coordination overhead of a traditional dev team with a persistent, self-aware multi-agent system that communicates in real time through a shared War Room.

---

## Status Key

| Badge | Meaning |
|-------|---------|
| `LIVE` | Deployed and running in production |
| `IN PROGRESS` | Built and committed — pending migration or deployment |
| `PLANNED` | Fully designed, ready to build |
| `FUTURE` | Backlog — after core phases are complete |

---

## Agent Squad

| Agent | Type | Role |
|-------|------|------|
| **ARGOS** | Orchestrator | Coordinates all agents, decomposes tasks, resolves conflicts |
| **ATLAS** | Code — Frontend | React, TypeScript, Tailwind, UI/UX |
| **HERCULOS** | Code — Backend | APIs, Supabase, edge functions, databases |
| **ATHENA** | Review & QA | Code review, testing strategy, merge gate approval |
| **PROMETHEUS** | Infra & Security | DevOps, CI/CD, repo management, security scanning |
| **APOLLO** | Design | UI/UX design, Figma, design tokens, visual polish |
| **HERMES** | Documentation | ADRs, API docs, memory, knowledge management |
| **Claude** | General | Architecture, strategy, code review, problem solving |

---

## Phases

---

### Foundation `LIVE`

**Goal:** A working War Room where human team members and AI agents collaborate in real time.

**What this enables:**
- Team members @mention specific agents to get expert responses on any topic
- Agents can raise their hand when they're relevant to a discussion
- Code agents commit files directly to the repo without leaving the chat
- Voice replies for natural, conversational interaction

**Delivered:**
- War Room UI with real-time multi-agent chat (Supabase Realtime)
- Hand-raise mechanism — agents self-evaluate relevance and join conversations
- Execution Bridge — Node.js service on GMK that processes agent tool calls
- `commit_code` tool — agents write and commit files directly from War Room
- ElevenLabs TTS integration — per-agent voice IDs for voice replies
- Whisper transcription for voice input
- Agent system prompts for ARGOS, ATLAS, HERCULOS, ATHENA, PROMETHEUS, APOLLO, HERMES

---

### Phase 0 — Shared Infrastructure `IN PROGRESS`

**Goal:** Eliminate duplicated code across edge functions and give each agent structured roles and capabilities.

**What this enables:**
- Consistent LLM calling behaviour across all agents (same provider detection, same tool handling)
- Capability-based routing — the orchestrator knows each agent's skills for task assignment
- All agents share security knowledge — any agent can flag auth, rate limiting, or CORS issues in any discussion

**Delivered:**
- Shared `_shared/` modules: `agent-caller.ts`, `context-builder.ts`, `event-bus.ts`, `types.ts`
- `route-message` and `autonomous-discuss` refactored to use shared modules (750→250 lines)
- `agent_type` and `capabilities` columns added to agents table
- PROMETHEUS and ARGOS system prompts updated with security mandates (no auth, no rate limiting, open CORS)
- TEAM KNOWLEDGE security section injected into every agent's context
- Voice/TTS fix: voice only generated when explicitly requested, never for code responses, always shows text transcript

**Pending deployment:** Agent capabilities migration, security knowledge migration, process-event edge function

---

### Phase 1 — Event Bus `IN PROGRESS`

**Goal:** Give agents a structured, typed communication channel separate from the human chat layer.

**What this enables:**
- Agents communicate directly with each other through well-defined events, not chat messages
- The War Room stays clean — only human-relevant events (escalations, completions, PRs) are surfaced there
- Foundation for all automation in later phases — every automated workflow runs on top of this bus

**Architecture:**
- `agent_events` table with typed channels: `orchestrator`, `code`, `review`, `testing`, `security`, `docs`, `design`, `broadcast`
- `agent_subscriptions` table — agents declare what events they handle
- `process-event` edge function routes events to subscribers, enforces no-self-processing rule
- Correlation IDs link related events across a workflow chain

**Pending deployment:** `agent_events` and `agent_subscriptions` migrations, `process-event` function

---

### Phase 2 — Orchestrator (ARGOS) Activation `PLANNED`

**Goal:** ARGOS becomes the intelligent project manager — decomposes tasks into execution graphs, routes subtasks to the right agents, and escalates when stuck.

**What this enables:**
- A human says "build a booking system for client X" → ARGOS breaks it down into a dependency graph of subtasks and assigns each to the right agent automatically
- No more manual task assignment — ARGOS factors in agent capabilities, current workload, and task type
- Deadlocks, timeouts, and agent disagreements are automatically escalated with full context — no silent failures

**Key deliverables:**
- `task_graph` schema: subtask nesting, `task_dependencies`, `escalations` tables
- `orchestrate-task` edge function: DAG decomposition → topological sort → capability-based routing → progress monitoring
- ARGOS connected to Anthropic API (currently has no API endpoint set)
- Frontend: subtask nesting in Kanban, dependency indicators, escalation panel

---

### Phase 3 — GitHub Integration `PLANNED`

**Goal:** Agents can create and manage GitHub repositories for external client projects.

**What this enables:**
- When starting a new project, PROMETHEUS creates the repo and sets up the workspace — no human intervention needed
- Code agents commit to any managed repo, not just OLYMPUS itself
- PRs are created automatically when code is ready for review
- Issues are created and tracked without leaving the agent workflow
- The system scales to managing multiple client projects simultaneously

**Architecture:**
- `managed_repos` table — authorization layer (which agents can access which repos)
- `@octokit/rest` added to execution bridge
- `github-client.ts` — Octokit wrapper with security boundaries (org-locked, no destructive methods)
- `github-executor.ts` — execution handlers for all GitHub operations
- Multi-repo workspace layout: `/home/argos/repos/{owner}/{repo-name}/`

**New agent tools (per-agent filtering):**

| Tool | Who has it | What it does |
|------|-----------|--------------|
| `create_repo` | PROMETHEUS | Creates new GitHub repo for a client project |
| `clone_repo` | PROMETHEUS | Clones repo to execution server workspace |
| `commit_code` (updated) | ATLAS, HERCULOS, Claude | Now supports any managed repo, not just OLYMPUS |
| `create_pr` | ATLAS, HERCULOS, Claude, ATHENA | Opens a PR when work is ready for review |
| `merge_pr` | ATHENA | Merges a PR after all gates pass |
| `create_issue` | All agents | Creates GitHub issues for bugs, features, blockers |

**Security boundaries:** Org-locked (no operations outside configured GitHub org), `managed_repos` authorization check per request, no `main` push, no force push, no workflow modification, PAT never exposed to agents

---

### Phase 4 — Code Review + Merge Gates `PLANNED`

**Goal:** No code reaches `main` without passing a triple-gate approval: code review, testing, and security.

**What this enables:**
- ATHENA automatically reviews every PR — no human required for routine reviews
- Multi-round review loops: agent writes code → ATHENA reviews → requests changes → agent iterates
- After N rounds of disagreement, the conflict is escalated to a human with a clear summary of both positions and a recommended resolution
- A PR cannot be merged unless all three gates (code review, testing, security) show ✅

**Key deliverables:**
- `review_rounds`, `review_disagreements`, `merge_gates` tables
- `review-pr` edge function: fetch diff → LLM review → structured findings → iterate or approve
- DB trigger: reviewer cannot be the same agent that created the PR (no self-review)
- Configurable merge gates — code review + testing + security — stored as data, not code

---

### Phase 5 — Testing & Performance Agent `PLANNED`

**Goal:** Automated test execution on every PR, with merge blocking if coverage or performance thresholds are breached.

**What this enables:**
- Tests run automatically before any PR can merge — no human needs to trigger them
- Performance is measured and compared to the `main` branch baseline — regressions are caught before they ship
- Agents can generate test files for new code they write, reducing the gap between shipping and coverage

**Key deliverables:**
- `test_runs` and `perf_profiles` tables
- `test-runner.ts` in execution bridge: checkout → install → vitest JSON reporter → coverage → bundle size profiling
- `generate_tests` agent tool — agents write and commit test files for their own code
- CI/CD pipeline update: tests block build if thresholds fail

---

### Phase 6 — Documentation & Agent Memory `PLANNED`

**Goal:** Agents remember decisions across sessions and automatically keep documentation up to date.

**What this enables:**
- When an agent makes an architectural decision, it saves it to shared memory — other agents won't repeat the same investigation
- Every completed task and merged PR automatically triggers a documentation update (ADR, API doc, changelog)
- Over time, the system accumulates institutional knowledge — new projects benefit from lessons learned on previous ones

**Key deliverables:**
- `agent_memory` table with full-text search (`tsvector`) — agents query relevant memories before responding
- `generated_docs` table — auto-generated ADRs, API docs, changelogs committed to repo
- `remember` agent tool — any agent can save decisions, patterns, rejected approaches
- HERMES triggered on `task.completed` and `pr.merged` events to generate/update docs

---

### Phase 7 — Security & Infrastructure Scanning `PLANNED`

**Goal:** Automated security review as a merge gate, live dependency vulnerability tracking, and production monitoring foundation.

**What this enables:**
- Every PR is security-reviewed automatically — secret leaks, injection risks, auth bypasses, and CORS misconfigurations are caught before they reach `main`
- Vulnerable dependencies are caught proactively — the system creates its own PRs to bump affected packages
- Security findings are visible across all projects in one place

**Key deliverables:**
- `security_findings` and `vulnerability_findings` tables
- `security-review` edge function: LLM-powered PR security analysis (not static rules)
- Dependency auditor service: `npm audit` + OSV API + GitHub Advisory Database → auto-PR for safe bumps
- PROMETHEUS takes action on findings via event bus

---

### Phase 8 — Design (Figma) + Product (ClickUp) `PLANNED`

**Goal:** Close the loop between design, requirements, and implementation — agents validate that what's built matches what was designed and specified.

**What this enables:**
- APOLLO detects drift between Figma design tokens and the live codebase — mismatches are flagged before they accumulate
- Before any PR merges, the code is checked against the task's acceptance criteria — scope creep and missing requirements are surfaced early
- ClickUp tasks stay in sync with the internal system — status updates flow both ways without manual work

**Key deliverables:**
- `figma-bridge` edge function: Figma REST API → design token extraction → Tailwind config comparison
- `requirements-check` edge function: LLM comparison of PR diff vs task acceptance criteria
- `clickup-adapter.ts`: bi-directional sync (ClickUp ↔ internal `tasks` table)
- `clickup-webhook` edge function: receives ClickUp task events in real time

---

### Phase 9 — Content & DevRel `FUTURE`

**Goal:** Turn completed work into shareable content automatically.

**What this enables:**
- Every shipped feature becomes a candidate for a tweet, LinkedIn post, or changelog entry
- Content is queued for human approval before publishing — agents suggest, humans decide
- Session summaries are generated so the team never loses context on what was built and why

**Key deliverables:**
- `content_queue` table: `twitter`, `linkedin`, `devto`, `changelog`, `summary` content types
- `content-generator` edge function: subscribes to `task.completed`, generates platform-specific posts
- Content approval UI in frontend: review, edit, approve/reject, publish history
- Optional direct publishing via platform APIs when auto-publish is enabled

---

## Dependency Graph

```
Foundation (LIVE)
  └─→ Phase 0: Shared Infrastructure
        └─→ Phase 1: Event Bus
              ├─→ Phase 2: Orchestrator ─────────────────────────┐
              ├─→ Phase 3: GitHub Integration ──────────────────┐ │
              │     └─→ Phase 4: Code Review + Merge Gates ◄───┘ │
              │           └─→ Phase 5: Testing & Performance      │
              ├─→ Phase 6: Docs & Memory ─────────────────────── Phase 9: Content
              ├─→ Phase 7: Security Scanning ◄──────────── (depends on Phase 4)
              └─→ Phase 8: Design + Product ◄──────────── (depends on Phase 3)
```

Phases 6, 8, and 9 can be parallelized with other work once the event bus is live.

---

## System Architecture (Current)

```
┌─────────────────────────────────────────────────────────────┐
│  War Room (React + Supabase Realtime)                       │
│  Human ↔ Agent chat, voice input/output, task board        │
└──────────────────────────┬──────────────────────────────────┘
                           │
              ┌────────────▼────────────┐
              │  Supabase Edge Functions │
              │  route-message           │  ← handles @mentions, hand-raises
              │  autonomous-discuss      │  ← background agent collaboration
              │  process-event           │  ← event bus router (IN PROGRESS)
              └──────────┬─────┬────────┘
                         │     │
              ┌──────────▼─┐ ┌─▼──────────────┐
              │  Supabase  │ │  Agent Events   │
              │  (DB + RT) │ │  (In Progress)  │
              └──────────┬─┘ └────────────────┘
                         │
              ┌──────────▼──────────────┐
              │  Execution Bridge       │
              │  Node.js on GMK server  │
              │  • code_commit (LIVE)   │
              │  • GitHub ops (PLANNED) │
              └──────────┬──────────────┘
                         │
              ┌──────────▼──────────────┐
              │  GitHub                 │
              │  (git push today)       │
              │  (full API — Phase 3)   │
              └─────────────────────────┘
```

---

## Required API Keys / Tokens

| Service | Key | Phase | Status |
|---------|-----|-------|--------|
| Anthropic | `ANTHROPIC_API_KEY` | Foundation | Live |
| ElevenLabs | `ELEVENLABS_API_KEY` | Foundation | Live |
| Whisper / OpenAI | `OPENAI_API_KEY` | Foundation | Live |
| Kimi / Moonshot | `KIMI_API_KEY` | Foundation | Live |
| GitHub PAT | `GITHUB_PAT` | Phase 3 | Needed |
| Figma PAT | `FIGMA_ACCESS_TOKEN` | Phase 8 | Needed |
| ClickUp API Token | `CLICKUP_API_TOKEN` | Phase 8 | Needed |
| OSV API | Public (no key) | Phase 7 | — |
| Twitter/X API | `TWITTER_API_KEY` | Phase 9 | Future |
| LinkedIn API | `LINKEDIN_ACCESS_TOKEN` | Phase 9 | Future |
