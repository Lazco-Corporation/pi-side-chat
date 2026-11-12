# pi-side-chat

Pi extension: `/side` and `/btw` open a side chat beside the main thread.
Ask a question without adding to the thread, while the main agent keeps working.

[Installation](#installation) · [Usage](#usage) · [Approvals](#approvals) · [Bring back](#bring-back) · [The main agent and side chat changes](#the-main-agent-and-side-chat-changes) · [What the side chat reads](#what-the-side-chat-reads) · [Limitations](#limitations)

## Highlights

- **The main agent keeps working.** A side chat runs as its own agent session, so it never interrupts the main run.
- **It knows what the thread knows.** It starts from the main conversation, plus a digest of what the main agent did since its last settled point.
- **Real tools.** The side chat can `read`, `grep`, `find`, `ls`, run `bash`, `edit`, and `write` in the same working directory.
- **Its own model.** Each side chat can switch its model and thinking level without touching the main session.
- **Changes ask first.** The first run of a side chat asks before every `bash`, `edit`, and `write`. After that, its mode decides.
- **Bring back what you learned.** One key puts the side chat into the main thread's next message.
- **The main agent is not blindsided.** It learns which files a side chat changed, and its first write to such a file is stopped until it reads the file again.

## Installation

You need [pi](https://github.com/earendil-works/pi) and Node.js 22.19.0 or later.

```sh
pi install npm:@lazco/pi-side-chat
```

Then run `/reload` in pi.

## Usage

| Command | What it does |
| --- | --- |
| `/side <question>` | Starts a new side chat and asks the question. |
| `/btw <question>` | The same as `/side`. |
| `/side` | Lists the side chats to open one, or starts a new empty side chat. |

The side chat opens in an overlay over the chat.
Its title is the first line of your first question.
The top right corner shows the model, the thinking level, and the permission mode.

A side chat that never got a message goes away when you close it.
A session switch, `/reload`, or quitting pi ends the side chats that run.

### Several side chats

Each `/side <question>` starts a new side chat, and they run side by side.
`/side` alone lists them, with **New side chat** on top, so you can open one again.

Press `q` to close the overlay and leave the side chat running.
While side chats exist, a widget above the editor lists each of them with its state:

| State | Meaning |
| --- | --- |
| `running` | The side chat works on your message. |
| `waits for approval` | A call waits for `y` or `n`. The footer of pi also says so. |
| `new reply` | A run ended while its overlay was closed. |
| `idle` | Nothing new since you looked. |

Press `d` in a side chat to delete it, after a confirmation.

### Keys

The overlay has a browse mode with one-letter keys, and an input line for typing.

| Key | Action |
| --- | --- |
| `Tab` or `Enter` | Open the input line |
| `y` / `n` | Approve or deny the call that waits |
| `b` | Bring the side chat back to the main thread |
| `p` | Switch between `ask` and `auto` |
| `m` | Choose the side chat's model |
| `t` | Step to the next thinking level |
| `c` | Copy the newest reply as Markdown |
| `d` | Delete the side chat, after a confirmation |
| `↑` `↓` `j` `k`, mouse wheel | Scroll one line |
| `PgUp` `PgDn` `Space` | Scroll one page |
| `Home` `End` `g` `G` | Go to the top or the bottom |
| Mouse drag | Select text and copy it, in fullscreen mode |
| `Esc` | Stop the run, or close the overlay when nothing runs |
| `q` | Close the overlay, and leave a run going in the background |

In the input line, `Enter` sends and `Esc` goes back to the keys, with your text kept.
A message that you send while the side chat runs waits for the run to end.

## Model and thinking level

A new side chat uses the main session's model and thinking level at the time you open it.
Later changes in the main session do not reach a side chat that is already open.

Press `m` to choose another model for this side chat.
The list holds the models that have a key or a login, with the current one marked.
Type to filter it, then press `Enter` to choose or `Esc` to cancel.
The thinking level stays, or becomes the nearest level that the new model supports.
Press `t` to step through the thinking levels that the model supports.

Both keys change only this side chat, from its next run on.
The main session and your default model stay as they are.
While the side chat runs, both keys wait: let the run end, or press `Esc` to stop it.

To ask a cheap model from the first question, open an empty side chat with `/side`, press `Esc`, press `m`, and then ask.

## Approvals

The side chat works in the same directory as the main thread, so the calls that can change it wait for you: `bash`, `edit`, and `write`.
Reading tools never wait.

- **The first run** of a side chat asks before every such call, whatever the mode, because you have not seen what the side chat does yet.
- **After that**, the mode decides. `ask`, the default, asks every time. `auto` lets the calls run. Press `p` to switch.

A waiting call shows its command or its file above the input line.
Press `y` to let it run, or `n` to deny it.
A denied call reaches the model as "The user denied this call."
Stopping the run denies every call that waits.

## Bring back

Press `b` to give the main thread what the side chat found.
Nothing goes to the main agent at once.
The side chat waits, and the footer of pi shows `Bring back waits: <title>`.
It goes with the next message that you send in the main thread, so you decide what the main agent does with it.
The note shows in the chat after your message.

The note holds your questions and the side chat's replies, each cut to 4000 characters, and one line for each command and changed file.
It is at most 20000 characters, and keeps the newest part.
It leaves out the conversation that the side chat inherited from the main thread.

Bring back is available when:

- the main agent is idle and has no queued message,
- the side chat is idle, and its newest reply ended normally,
- no other side chat waits to go back.

When it is not available, the overlay says why.
Press `b` again in the same side chat to replace the note with the newest state.

## The main agent and side chat changes

A side chat does not tell the main agent what you asked.
It does tell it which files it changed, so the main agent does not work from an old copy.
Only `edit` and `write` are tracked, because their arguments name the file.

- **A change note.** When a side chat run ends and it changed files, the main agent gets a note that names the side chat and the files. A running main agent reads it before its next model call. An idle one gets it with your next message, so the note never starts a run. The note shows in the chat too.
- **A stop on stale writes.** The main agent's first `edit` or `write` of a file that a side chat changed is stopped, with the reason that the file changed and must be read again. A `read` of the file, or that one stop, clears it.

## What the side chat reads

The side chat starts from the main conversation, up to a settled point.

- While the main agent is idle, it gets the whole branch.
- While the main agent runs, it gets the branch up to the end of the last finished run. The entries of the run in progress can still change, so they are not copied.
- During the first run of a session, it gets no conversation.

With the first question, the side chat also gets a note that says it is a side chat, that the main thread may still run in the same directory, and which tools it has.
The note holds a digest of what the main thread did after the settled point: your messages, the agent's replies, its commands, and the files it changed.
The note is at most 8000 characters, and keeps the newest lines.

The `main_thread_read` tool reads the same digest again at any time, with the main agent's current state, so the side chat can follow a long main run.

The side chat uses the main session's system prompt, and starts with its model and thinking level.
It loads no extensions, skills, or context files of its own, so it has only the tools listed above.

## Limitations

- **Interactive mode only.** In RPC, JSON, and print mode, the commands only warn.
- **Each first question costs a full read.** The side chat has other tools than the main session, so the provider cannot reuse the main session's prompt cache. The first run reads the whole conversation at full price.
- **`bash` changes are not tracked.** A side chat that changes files with `npm install`, `sed -i`, or `git checkout` sends no note, and the main agent is not stopped.
- **A small model can misread the main thread.** In tests of pi-recap, small models sometimes reported a finished step as open. A side chat on a cheap model can describe the state of the main thread wrongly.
- **No extension tools.** The side chat has no MCP tools, no web search, and no other extension tools.

## Contributing

To report a bug or ask a question, open an issue on [GitHub](https://github.com/Lazco-Corporation/pi-side-chat/issues).
The build, test, and release steps are in [AGENTS.md](AGENTS.md).

## License

[AGPL-3.0-or-later](LICENSE)
