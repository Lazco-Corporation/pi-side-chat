# AGENTS.md

`@lazco/pi-side-chat` is a pi extension with two commands, `/side` and `/btw`.
Each opens a side chat: an agent session of its own, with tools, that starts from what the main thread knows.
The main agent keeps working while the user asks.
Nothing from the side chat enters the main session, except a note about the files that it changed and the text that the user brings back.

## Commands

| Command | What it does |
| --- | --- |
| `bun run check` | Type-check. |
| `bun run test` | Run the unit tests under node. |
| `npm run release -- <bump>` | Cut a release. See **Release** below. |

The package ships TypeScript source, so there is no build step.

## Layout

All source sits under `src/`.

| File | What it holds |
| --- | --- |
| `index.ts` | the two commands and the main session events |
| `registry.ts` | the side chats of the main session, the overlay that each command opens, and what the main agent learns from them |
| `sideChat.ts` | one side chat: its agent session, its permission mode, and the calls that wait for approval |
| `child.ts` | builds the agent session of a side chat from the main session's system prompt |
| `fork.ts` | where a side chat forks off the main branch, and the main activity after that point |
| `context.ts` | the framing and the activity digest that the side chat gets with its first question |
| `approval.ts` | which calls wait for the user, in the first run and in each mode |
| `changes.ts` | the files that side chats changed, the stop on the main agent's stale writes, and the change note |
| `mainThreadRead.ts` | the `main_thread_read` tool |
| `bringBack.ts` | the Bring back note, when it is available, and the newest reply check |
| `modelPicker.ts` | the model list over the overlay, and the thinking level steps |
| `status.ts` | the widget above the editor and the approval note in the footer |
| `store.ts` | the side chat files: writing, loading, deleting, and removing orphans |
| `transcript.ts` | the overlay transcript, built from the side chat's own entries |
| `overlay.ts` | the overlay with the transcript, the approval, the input line, the scroll, and the keys |
| `emphasis.ts` | copied from pi-recap: the fix that lets the overlay parse `**` bold and `*` italic next to CJK punctuation |
| `selection.ts` | copied from pi-recap: the mouse text selection inside the overlay, for fullscreen mode |

`docs/verification.md` records each end-to-end run in Pi-Bolt.
`spike/l0.ts` is the extension that checked the pi APIs before the first layer. It does not ship.

## Testing

Unit tests cover the logic in every module except `overlay.ts`, `registry.ts`, `child.ts`, and `index.ts`, which need a running pi.
Every change to the behavior also needs an end-to-end run in Pi-Bolt inside tmux, recorded in `docs/verification.md`.
Load the extension with `pi-bolt --no-extensions -e <path to src/index.ts>`, and once with all installed extensions.

## Dependencies

Read `docs/packages.md` in the installed `@earendil-works/pi-coding-agent` before you add a dependency.

- A package that pi bundles goes in `peerDependencies` with a `"*"` range. Never bundle one.
- Any other runtime dependency goes in `dependencies`.

## Release

`npm version` owns the version number.
Never edit the `version` field in `package.json` by hand.

Every release has a `CHANGELOG.md` entry, and the GitHub release shows that entry.
Cut a release from `main` in this order:

1. Add a `## [<version>] - <YYYY-MM-DD>` section at the top of `CHANGELOG.md`, below the intro.
2. Add a `[<version>]: <compare-url>` link at the bottom of `CHANGELOG.md`.
3. Commit the entry and push `main`.
4. Run the release command:

```bash
npm run release -- <bump>
```

`<bump>` is `patch`, `minor`, `major`, `prepatch`, `preminor`, `premajor`, `prerelease`, or an exact version such as `<MAJOR>.<MINOR>.<PATCH>`.
Add `--dry-run` to run every check and print the plan without a change.

The script refuses to start unless the branch is `main`, the working tree is clean, `main` agrees with its upstream, and `npm run check` and `npm run test` pass.
It then runs `npm version <bump>`, refuses a version that has no `CHANGELOG.md` section or is already on npm, and pushes `main` and the `v<version>` tag.
If a step after the bump fails, it resets to the starting commit and deletes only the tag that this run created.

A push of a `v*` tag starts `release-npm.yml`.
The workflow refuses a tag that `main` does not hold.
It then reads the `CHANGELOG.md` section for the version, installs, type-checks, tests, reads `NPM_TOKEN` from Infisical, and publishes with provenance.
Last, it creates the GitHub release with the `CHANGELOG.md` section, followed by the notes that GitHub generates.
A missing section stops the workflow before the publish.
A version with a `-` goes to the `next` dist-tag. A normal version goes to `latest`.

The workflow needs this one-time setup:

1. The Infisical project `lazco-pi-side-chat`, env `prod`, path `/ci`, with `NPM_TOKEN`.
2. The repo variable `INFISICAL_CI_IDENTITY_ID`.
3. The Infisical machine identity, bound to this repo.

### Pick the bump

- `patch` for a fix only.
- `minor` for new user-facing behavior, such as a new key or command.
- `major` for a change that breaks a user setup.

### Write the changelog entry

- Write only changes that a user can see. Leave out CI, tests, and refactors.
- Group the items under `### Added`, `### Changed`, `### Fixed`, `### Removed`, or `### Docs`.
- Put each full sentence on its own line.
