# Issue tracker: beads (bd)

<!-- Owned by markn-team-kit. Do not rewrite this file via /setup-matt-pocock-skills. This repo's tracker is beads and that choice is not up for re-selection. -->

Issues and specs for this repo live in the beads database under `.beads/`, reached only through the `bd` CLI. Run `bd prime` once per session for the live command surface, and `bd <command> --help` for anything this file does not cover.

## Conventions

- Issues are created at the plan stage, before any code. Shape the graph first, epic then children then dependency edges.
- One issue is one atomic task ending in a check. If the title needs an "and", split it.
- Strict lifecycle. `bd ready`, then `bd update <id> --claim`, then `bd close <id> --reason "..."`. Claim before any work, close as soon as the check passes.
- `bd ready` is the only source of truth for what may start now. Anything it lists can run in parallel.
- Work discovered mid-task becomes an issue, never a silent side quest. `bd create "<title>" --deps discovered-from:<current-id>`
- Record why, not only what. A durable choice gets its own issue with `-t decision`. Findings and progress go to `bd update <id> --append-notes "..."` as you work, so the reasoning survives compaction.
- Triage state is a label. Apply with `bd update <id> --add-label <label>`, drop with `--remove-label` (the role strings live in `docs/agents/triage-labels.md`, written by `mattpocock-skills:setup-matt-pocock-skills` when you enable `/triage`).

## When a skill says "publish to the issue tracker"

`bd create "<title>" -d "<description>" -t <bug|feature|task|epic|chore|decision> -p <0-4>`

For a plan with more than one issue, create the epic first, then each child with `--parent <epic-id>`, then wire blocking edges in a second pass. An edge is `--deps blocked-by:<id>` at create time (bare `--deps <id>` means the same) or `bd dep add <blocked> <blocker>` afterwards. Both make the new issue depend on `<id>`. `--deps blocks:<id>` is the opposite direction, so do not use it here. The second pass exists because children need ids before they can reference each other.

## When a skill says "fetch the relevant ticket"

`bd show <id>`, which prints the description and the notes. Add `--long` for extended metadata and `--children` to list an epic's children. The user normally passes the id directly.

## Wayfinding operations

Used by `/wayfinder`. The **map** is an epic and its **child** tickets are that epic's children.

- **Map**: `bd create "<destination>" -t epic -l wayfinder:map -d "<body>"`. The description holds Destination, Notes, Not yet specified, and Out of scope, rewritten with `bd update <map-id> -d "..."` when the fog shifts. Decisions-so-far is the notes field, one line appended per closed ticket with `bd update <map-id> --append-notes "..."`. `bd show <map-id>` loads both.
- **Child ticket**: `bd create "<question>" --parent <map-id> -l wayfinder:<type> -d "## Question ..."`, where `<type>` is `research`, `prototype`, `grilling`, or `task`.
- **Blocking**: `bd dep add <blocked> <blocker>`, the native blocks edge that `bd ready` reads. A ticket is unblocked when every blocker is closed.
- **Frontier**: `bd ready --parent <map-id>`. It already drops blocked and claimed tickets, so the first row wins.
- **Claim**: `bd update <id> --claim`, the session's first write. It sets the assignee and moves the ticket to in_progress, which takes it off every other session's frontier.
- **Resolve**: `bd update <id> --append-notes "<the answer>"`, then `bd close <id> --reason "<one-line gist>"`, then append that gist and the ticket id to the map with `bd update <map-id> --append-notes "..."`.
- **Out of scope**: close the ticket with a reason saying it sits past the destination, then record the same line in the map's Out of scope section.

## Setup

`/markn-setup` checks that `bd` is installed and runs `bd setup claude` / `bd setup codex`. If `bd` is missing, install it with `brew install beads` or `npm i -g @beads/bd`.
