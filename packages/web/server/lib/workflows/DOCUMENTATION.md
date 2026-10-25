# Agent workflows

## Purpose

A workflow is a JavaScript script an agent writes to fan a large task out to
many agents: a review per file, an audit across many routes, a migration of
many files, research cross-checked across sources. OpenChamber runs the script
here, in its own server, so the agent that asked stays free. The user approves
each run's plan in the chat before anything starts, and when the run ends its
report is delivered into the session that proposed it.

The feature ships dark: `OPENCHAMBER_WORKFLOWS_ENABLE` (`feature-flag.js`)
decides whether it exists at all. Without it there is no runtime, no routes, no
`openchamber_workflow` tool, no settings row and no session guidance. With it,
the tool is on unless the user switches it off (`agentWorkflowToolEnabled`).

## Ownership

- `script.js`: parses a script into `meta` (`name`, `description`, `phases`)
  and the body, and checks that the body compiles. Errors are written for the
  agent that wrote the script.
- `sandbox.js`: runs a body in a worker thread, inside a vm context that sees
  only `agent()`, `parallel()`, `pipeline()`, `phase()`, `log()` and `args`.
- `agent-session.js`: one workflow agent is one OpenCode child session of the
  proposing session (`parentID`), prompted once and awaited until its turn
  ends; a schema correction is a follow-up prompt in the same session. Also
  posts the report as a synthetic message.
- `json-schema.js`: the small part of JSON Schema `agent({ schema })` checks.
- `store.js`: run files under `<data-dir>/workflow-runs/`, one per run.
- `runtime.js`: the run lifecycle, the limits, replay, the report, and the
  agent tool's `workflow.*` actions (`executeAction`).
- `routes.js`: the user's side for the chat card and the work-status panel:
  `GET /api/openchamber/workflows?sessionId=` and
  `POST /api/openchamber/workflows/:runId/{approve,decline,stop,resume}`.

The tool declaration (description, parameters, the scripting guide on
`script`) lives with the other managed tools in `../agent-tool/runtime.js`;
the action list in `../openchamber-control/actions.js`; when to offer a
workflow in `../session-knowledge/runtime.js` (`WORKFLOW_GUIDANCE`).

## Lifecycle

1. `workflow.run` parses the script (or reads a saved one by name), stores a
   run in `awaiting-approval` and answers at once with its id. Nothing runs.
2. The chat draws the run as a card in place of the call, with Run and Don't
   run; the work-status panel offers the same. Approve starts it; decline ends
   it as `declined`.
3. Running: the sandbox calls `agent()`, each call waits for a slot
   (`MAX_CONCURRENT_AGENTS`), creates its child session and waits for its turn.
   Every change is saved and broadcast as `openchamber:workflow-run`
   (throttled per run) with the run's summary.
4. The script returns (`completed`), throws (`failed`), or is stopped
   (`stopped`). Agents still running are interrupted and counted as stopped.
5. The report, a synthetic message `<openchamber-workflow …>` with metadata
   `{ source: 'openchamber-workflow', runId, name, state }`, goes into the
   proposing session. A completed or failed run wakes it (`resume: true`); a
   declined or stopped one does not, because the user is the one who acted.

`workflow.status` and `workflow.result` read a run's progress and any agent's
full answer by key or session id; the agent can only reach runs its own
session proposed. `workflow.save` writes a script to
`.openchamber/workflows/<name>.js` in the session's directory, and
`workflow.run` with `name` runs it.

## Invariants

- No run starts without the user's approval through the route; the agent tool
  has no approve action.
- An agent of a running workflow cannot propose another workflow: one level of
  fan-out only.
- A run starts at most `MAX_AGENTS_PER_RUN` agents; further `agent()` calls
  resolve to null with a log line. At most `MAX_CONCURRENT_AGENTS` work at once.
- `agent()` resolves to the answer text, the parsed JSON when a schema was
  given, or null when the agent failed or was stopped. It never rejects into
  the script.
- A report is minted with its message id before the first delivery attempt
  and saved, so a retry never delivers twice (409 counts as delivered).
- A run that was `running` when the server stopped is marked `stopped` with
  "OpenChamber restarted…" on the next start; its report goes out once the
  OpenCode event hub connects (`deliverPending`).
- A run is in the runtime's `active` map from the moment it is `running`
  until its end is saved; a stop that arrives before the worker exists is
  honoured once it does. The report goes out after the run left `active`, so a
  slow delivery never holds a finished run as running.
- Only a `failed` or `stopped` run resumes. Completed answers an attempt did
  not ask for again stay on the run for the next attempt.
- A prompt is never sent once the run stopped; one in flight when it stopped
  interrupts the turn it started.
- The tool is never behind Code Mode: the chat draws the run's card from the
  tool's own call, which an `execute` script would hide.
- The run files are owner-readable only; a file that does not parse is moved
  aside and the rest load. At most 100 runs are kept; finished ones are pruned
  by oldest end, never an open one, the one just saved, or one whose report
  has not gone out.

## Decisions

### Why the server runs the script and not OpenCode's Code Mode

Code Mode runs a script inside the agent's own tool call, so the agent's turn
stays busy for the whole run, and OpenCode's subagent tool is not callable
from Code Mode (`codemode: false`). Running here, the tool call answers at
once, the run survives the agent's turn, and the report arrives the way a
dispatched session's result does.

### Why a worker with a vm context, evaluated from a string

The worker can be terminated whatever the script does, including a loop that
never yields, and its heap is capped. The vm context keeps the server's
modules, `process`, timers and network out of the script's reach. This is not
a boundary against the agent, which has a shell; it keeps a script from
reaching or stalling the server. The worker source is a string (`eval: true`)
so it runs the same from the source tree under Bun, from `node_modules` under
Node, and from inside the desktop app's asar archive, where a worker file path
would not load.

### Why agents are child sessions of the proposing session

OpenCode lists them as that session's subagents, so they are visible, open
like any subagent, and their cost rolls up into the session. A child session
lives at its parent's location, so agents share the session's directory: there
is no isolated copy per agent yet, and a script that edits files gives each
agent files of its own.

### Why replay keys on the prompt and not on the call's position

`resume` runs the script again from the top. Each `agent()` call is keyed by a
hash of its prompt and options plus how many times the same pair was asked
before, and a call whose key completed last time returns its saved answer
without a session. Calls in `parallel()` start in an order that can change
between attempts; keying by position would rerun finished agents or, worse,
hand an answer to the wrong call. `Math.random()`, `Date.now()` and `new
Date()` throw in the sandbox so a prompt cannot differ between attempts by
accident.

### Why approval is a stored state and not a held tool call

`render.page` with `awaitAnswer` holds its call open until the user answers.
A workflow run instead is stored as `awaiting-approval` and the call answers
at once: the card reads the run from this server, so it survives a reload,
shows on every device, and the agent's turn is not held while the user reads
the plan.

## Runtime parity

Web and desktop with a managed OpenCode: available when the build flag is set
(the agent tool exists only there). VS Code and an external OpenCode: the
agent tool is not injected, so no run is ever proposed. Mobile clients see the
card, approve and stop runs, and get the report through the server they are
connected to; the work-status panel is not shown on phones.
