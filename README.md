# Worktree Janitor

See every git worktree your agents have sprouted — branch, age, dirt, merged-ness — and prune the dead ones in one click.

A [workspacer](https://github.com/DJTouchette/workspacer) hub plugin (sidecar + webview). Agent isolation loves worktrees; this is the cleanup crew.

## What it does

The sidecar asks the hub for your agents' working directories (`agents.list`), resolves each to its git repository, and runs `git worktree list` there. For every **linked** worktree (the primary checkout is never touched) it shows:

- **Branch** and how long ago its last commit was.
- **Dirty state** — count of uncommitted changes (a dirty worktree needs `--force` and says so).
- **Merged badge** — whether its branch is fully merged into the repo's default branch, i.e. safe to drop.

**Prune** runs `git worktree remove` (optionally deleting the branch when merged); only paths the janitor itself enumerated can be removed, dirty ones require an explicit force confirmation, and the primary worktree is excluded by construction.

## Install

Command palette → **Install Plugin…** → `DJTouchette/workspacer-plugin-worktree-janitor`

## Permissions

| Capability | Why |
|---|---|
| `agents.list` | find the repos your agents work in |

The sidecar shells out to `git` for everything else; no events consumed, no network beyond the local hub bus.
