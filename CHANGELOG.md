# Changelog

All notable changes to `@lazco/pi-side-chat` are listed here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the versions follow [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-11-12

### Added

- `/side` and `/btw` open a side chat in an overlay, as an agent session of its own that does not interrupt the main agent.
- The side chat starts from the main conversation up to the last settled point, with a digest of the main activity since then.
- The side chat can use `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, and `main_thread_read`.
- The first run of a side chat asks before every `bash`, `edit`, and `write`; after that, `p` switches between `ask` and `auto`.
- When a side chat changes files with `edit` or `write`, the main agent gets a note that names them.
- The main agent's first `edit` or `write` of such a file is stopped until it reads the file again.

[0.1.0]: https://github.com/Lazco-Corporation/pi-side-chat/releases/tag/v0.1.0
