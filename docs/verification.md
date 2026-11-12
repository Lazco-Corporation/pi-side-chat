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

## L1: one side chat

Run on 2026-11-12 with `src/index.ts`, in regular mode and in fullscreen mode.

| Scenario | Result |
| --- | --- |
| The main thread is idle and holds "pineapple". `/side What is the secret word?` | The overlay opened with the question as its title, and the side chat answered "pineapple". The main thread got no message. |
| `/btw` asks the side chat to `write` a file in its first run; the user presses `p` (auto), then `n` | The approval showed `write a.txt` with "The first run of a side chat asks before every change." even in auto mode. After `n`, the call showed as denied, the model said the file could not be created, and no file existed. |
| Second run in auto mode asks for the same `write` | No approval. The call showed `✓ write a.txt`, and the file held `hello`. |
| Third run in ask mode asks for `bash echo approved-run` | The approval showed the command with "The mode is ask. Press p for auto." After `y`, the command ran. |
| `/side another question` while a side chat with messages exists | Warning: "A side chat is already open. Run /side to open it, and press d there to delete it first." No new side chat. |
| `d` in the overlay | A confirm dialog opened over the overlay. Yes removed the side chat. |
| The main agent runs `sleep 30 && echo main-done`; `/side What is the main thread doing right now?` | The side chat answered `sleep 30 && echo main-done` from the activity digest. The main run went on and ended with `DONE`. |
| Fullscreen mode, during the first run of a new session (no settled leaf); `/side 主 thread 現在在跑什麼指令？` | The side chat answered in Chinese with `sleep 25 && echo first-done`, from a digest of the whole branch. |
| Chinese in the overlay input | `中文輸入測試` rendered after `› `, and the hardware cursor sat right after it (column 32 for a frame at column 16). |

## L2: the main thread and the side chat know about each other

Run on 2026-11-12 with every installed extension loaded (`pi-bolt -e src/index.ts`, without `--no-extensions`), so the main session's `edit` and `write` were Pi-Bolt's pix-edit and pix-write.

| Scenario | Result |
| --- | --- |
| The main agent writes `notes.txt` with `line one`. A side chat edits it to `line one, side change` (approved with `y`). The main agent is idle. | No main run started. The file held the side chat's text. |
| The user then asks the main agent to overwrite `notes.txt` without reading it. | The change note showed in the chat right after the user's message: `Side chat "…" changed files in the working directory: notes.txt.` The main `write` was stopped with `notes.txt was changed by side chat "…". Read it again before you change it.`, and the file kept the side chat's text. |
| The user asks the main agent to write the file again. | The agent read the file and wrote `main version`. The stop happened once. |
| The main agent runs `sleep 35`. A side chat calls `main_thread_read`, then writes `side.txt` (approved with `y`). | `main_thread_read` needed no approval, and the side chat answered "The main thread is running now. It runs the command sleep 35." The change note reached the main run before its next model call, and the main agent answered "Side chat … changed side.txt." |

## L3: Bring back

Run on 2026-11-12 with `--no-extensions`.

| Scenario | Result |
| --- | --- |
| The main thread is idle. The side chat answers "391 ZEBRA". The user presses `b`. | The overlay said "Brought back. The main thread gets this side chat with your next message there.", and the footer of pi showed `Bring back waits: Compute 17*23…`. Closing the overlay started no main run. |
| The user asks the main agent "What number and code word did the side chat find?" | The note `[side-chat-bring-back]` showed after the user's message, with the question and `- Assistant: 391 ZEBRA`. The main agent answered "The number is 391 and the code word is ZEBRA." The footer status went away. |
| The main agent runs `sleep 20`; the user presses `b` in the side chat. | "Available when the main thread is idle." Nothing was queued. |
| The main agent is idle and the side chat is counting to 40; the user presses `b`. | "Available when the side chat is idle." |

## L4: model and thinking level of each side chat

Run on 2026-11-12 with `--no-extensions`. The main session used `google-sub/gemini-3.8-flash` at `low`; the global default model was `anthropic-sub/claude-opus-5-5` at `high`.

| Scenario | Result |
| --- | --- |
| `/side` with no question, `Esc`, `m`, type `haiku-5-5` | The model list opened over the overlay and filtered to the two Claude Haiku 5.5 entries. |
| `↓ Enter` | The title bar showed `anthropic-sub/claude-haiku-5-5 · low · ask`, with "Model: oncloud_ai/anthropic-sub/claude-haiku-5-5, thinking low, from the next run on." |
| `t` three times | The level went `medium`, then `high`, then `xhigh`, each with a "Thinking: …" note. |
| Ask "Which company made you?" | "Anthropic". |
| `m` while that run ran | "Wait for this run to end, or press esc to stop it." No list opened. |
| `m`, choose `google-sub/gemini-3.8-flash`, ask again | The title bar showed `google-sub/gemini-3.8-flash · high · ask`: `xhigh` became `high`, the nearest level that model supports. The answer was "Google". |
| After all of it | The main footer still showed `google-sub/gemini-3.8-flash • low`, and `settings.json` still held `anthropic-sub/claude-opus-5-5` and `high`. |
| A model without a key | `getAvailable()` lists only models with a key or a login, so the list cannot offer one. The refusal path is covered by `test/sideChat.test.ts`: the error names the model, and the old model and level stay. |

## L5: several side chats in the background

Run on 2026-11-12 with `--no-extensions`, in regular mode.

| Scenario | Result |
| --- | --- |
| `/side Run this bash command: sleep 15 && echo alpha-done…`, then `q` while its first `bash` waits | The footer showed `esc stop · q close`. After `q`, the widget showed `◆ Run this bash command… · waits for approval`, and the footer of pi showed `Side chat "…" waits for approval. Run /side to answer.` |
| `/btw Say beta and nothing else.`, then `q` after the reply | The widget listed both: the first `waits for approval`, the second `idle`. |
| `/side` | A list opened with `New side chat`, `1. Run this bash command… · waits for approval`, and `2. Say beta… · idle`. |
| Choose 1, press `y`, then `q` | The widget showed `running`, and the approval note left the footer. After the 15 seconds, the row turned to `new reply` without the overlay open. Opening it showed `✓ bash sleep 15 && echo alpha-done` and `alpha-done`. |
| `b` in side chat 2, then `b` in side chat 1 | Side chat 2: "Brought back…". Side chat 1: `Side chat "Say beta and nothing else." already waits to go back. Send a message in the main thread first.` |
| Delete side chat 2 with `d` and Yes | The widget listed only side chat 1, still `idle`. The Bring back note of side chat 2 still waited, since it had been taken already. |
