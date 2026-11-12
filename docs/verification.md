# Verification log

Each layer of the plan ends with an end-to-end run in Pi-Bolt inside tmux.
This file records what ran and what it showed.

Environment for every run unless a section says otherwise:

- Pi-Bolt 1.0.1 (Pi 1.4.0), darwin-arm64.
- `pi-bolt --no-extensions -e <extension> --provider oncloud_ai --model google-sub/gemini-3.8-flash --thinking low --no-session`.
- tmux 160×45, in an empty directory.

## L0: technical checks

Spike: `spike/l0.ts`, run on 2026-11-12.

| Check | Result |
| --- | --- |
| `createAgentSession` with `SessionManager.inMemory(cwd, undefined, ctx.sessionManager.getBranch())` from an extension command | Works. The child answered "pineapple", a word that only the main conversation held. |
| Tool allowlist `read, bash, edit, write, grep, find, ls` | `session.getActiveToolNames()` returned all seven. |
| Provider auth in the child | Works with `modelRegistry` and `modelRuntime` taken from `ctx.modelRegistry`. |
| Inline extension under `noExtensions: true` | Loads. Its `tool_call` handler saw `write` and `bash`, and `{ block: true }` stopped `write`: the file was not created, and the model reported the block. |
| `bindExtensions()` | Not needed for `tool_call`, `tool_result`, and `agent_settled` in the inline extension. Both runs, with and without it, behaved the same. |
| `tool_result` for a blocked call | Not emitted. A blocked call reaches the model as an error result, but the inline extension sees only `tool_call`. |
| Overlay with a focused `Input`, Chinese text | `測試中文輸入` rendered, and the hardware cursor sat right after the last character (column 40 for a frame at column 24), so an IME window opens at the caret. |
| `ctx.ui.select()` while the overlay has focus | Shows in the editor area below the overlay and takes the keys. `↓ Enter` returned the second item, and `Esc` returned `undefined`. The overlay got the focus back: typing went into its input again. |

Log excerpt:

```
child active tools ["read","bash","edit","write","grep","find","ls"]
child tool_call write {"content":"hi","path":"/tmp/pi-side-chat-l0.txt"}
child tool_call bash {"command":"echo spike"}
child tool_result bash {"isError":false}
child agent_settled
child done {"deltas":3,"text":"The write tool was blocked by the L0 spike, while the bash command succeeded and output \"spike\".","messages":10}
child done {"deltas":1,"text":"pineapple","messages":6}
overlay submitted 測試中文輸入
select result second 第二
select result (cancelled)
```

Consequences for the design:

- The model picker of L4 may open as a second `ctx.ui.custom()` overlay or as `ctx.ui.select()`, since both get the focus over the side chat overlay. `ctx.ui.select()` has no text filter, so the picker is a custom component.
- The side chat has no `tool_result` for a denied call, so a denied call is recorded where it is denied.
