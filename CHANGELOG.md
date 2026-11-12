# Changelog

All releases of `@lazco/pi-side-chat` are in this file.
The newest release is at the top.

## [0.2.1] - 2026-11-12

### Fixed

- A side chat that failed to start, for example because its file could not be written, tries again with the next message instead of failing every message after it.

## [0.2.0] - 2026-11-12

### Added

- `b` in a side chat brings it back: the main thread gets its questions and replies with the next message that you send there.
- `m` chooses a model for the side chat from a list that you can filter, and `t` steps through its thinking levels, without changing the main session.
- Several side chats can run at once. `/side` alone lists them, and `q` closes the overlay while a side chat keeps running.
- A widget above the editor shows each side chat as running, waiting for approval, with a new reply, or idle, and the footer says when one waits for approval.
- Side chats of a saved main session are saved too, and come back when the main session starts again.
- Side chat files whose main session file is gone are deleted at session start.

## [0.1.0] - 2026-11-12

### Added

- `/side` and `/btw` open a side chat in an overlay, as an agent session of its own that does not interrupt the main agent.
- The side chat starts from the main conversation up to the last settled point, with a digest of the main activity since then.
- The side chat can use `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, and `main_thread_read`.
- The first run of a side chat asks before every `bash`, `edit`, and `write`.
  After that, `p` switches between `ask` and `auto`.
- When a side chat changes files with `edit` or `write`, the main agent gets a note that names them.
- The main agent's first `edit` or `write` of such a file is stopped until it reads the file again.

[0.2.1]: https://github.com/Lazco-Corporation/pi-side-chat/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Lazco-Corporation/pi-side-chat/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Lazco-Corporation/pi-side-chat/releases/tag/v0.1.0
