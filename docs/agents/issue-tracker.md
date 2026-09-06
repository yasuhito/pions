# Issue tracker: GitHub

Issues and specs for this repository live in GitHub Issues at `yasuhito/pions`. Use the `gh` CLI for operations.

Until the local Git remote identifies this repository, pass `-R yasuhito/pions` explicitly. Once the remote exists, either explicit `-R` or repository inference is acceptable.

## Conventions

- Create: `gh issue create -R yasuhito/pions --title "..." --body-file <file>`.
- Read with comments and labels: `gh issue view -R yasuhito/pions <number> --comments`.
- List: `gh issue list -R yasuhito/pions --state open --json number,title,body,labels,comments`.
- Comment: `gh issue comment -R yasuhito/pions <number> --body-file <file>`.
- Change labels: `gh issue edit -R yasuhito/pions <number> --add-label "..."` or `--remove-label "..."`.
- Close: `gh issue close -R yasuhito/pions <number> --comment "..."`.

GitHub Issues and pull requests share one number space. Resolve an ambiguous number with `gh pr view` and fall back to `gh issue view`.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## Publishing work

When a skill says to publish a spec or ticket, create one GitHub issue per item. Publish blocker tickets first. Represent blocking edges with GitHub native issue dependencies when available; otherwise put `Blocked by: #<number>` near the top of the dependent issue.

A ticket is ready to start only when every blocker is closed. Apply `ready-for-agent` to agent-ready tickets produced from an approved spec.
