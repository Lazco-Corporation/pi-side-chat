# How pi-side-chat works

This page gives the rules behind the features in the [README](../README.md).

- [What the side chat reads](#what-the-side-chat-reads)
- [Bring back](#bring-back)
- [Side chat changes](#side-chat-changes)
- [Saved side chats](#saved-side-chats)

## What the side chat reads

The side chat starts from the main conversation, up to a settled point.

- While the main agent is idle, the side chat gets the whole branch.
- While the main agent runs, the side chat gets the branch up to the end of the last finished run. The entries of the run in progress can still change, so they are not copied.
- During the first run of a session, the side chat gets no conversation.

With the first question, the side chat also gets a note.
The note says that it is a side chat, that the main thread can still run in the same directory, and which tools it has.
The note also holds a digest of what the main thread did after the settled point: your messages, the agent's replies, its commands, and the files it changed.
The note is at most 8000 characters, and keeps the newest lines.

The `main_thread_read` tool reads the same digest again at any time, with the current state of the main agent.
With this tool, the side chat can follow a long main run.

The side chat uses the system prompt of the main session.
It starts with the model and the thinking level of the main session.
It loads no extensions, skills, or context files of its own.
Its tools are `read`, `grep`, `find`, `ls`, `bash`, `edit`, `write`, and `main_thread_read`.

## Bring back

Press `b` to give the main thread what the side chat found.
The note goes with the next message that you send in the main thread.
Until then, the footer of pi shows `Bring back waits: <title>`.
The note shows in the chat after your message.

### What the note holds

- Your questions and the side chat's replies, each cut to 4000 characters.
- One line for each command and each changed file.

The note is at most 20000 characters, and keeps the newest part.
It leaves out the conversation that the side chat got from the main thread.

### When you can bring back

Bring back is available when all of these are true:

- The main agent is idle and has no queued message.
- The side chat is idle, and its newest reply ended normally.
- No other side chat waits to go back.

When Bring back is not available, the overlay says why.
Press `b` again in the same side chat to replace the note with the newest state.

## Side chat changes

A side chat does not tell the main agent what you asked.
It tells the main agent which files it changed, so that the main agent does not work from an old copy.
Only `edit` and `write` calls are tracked, because their arguments name the file.

### The change note

When a side chat run ends and the run changed files, the main agent gets a note.
The note names the side chat and the files.

- A running main agent reads the note before its next model call.
- An idle main agent gets the note with your next message, so the note never starts a run.

The note also shows in the chat.

### The stop on stale writes

The main agent's first `edit` or `write` of a file that a side chat changed is stopped.
The reason that the main agent gets says that the file changed and that it must read the file again.
A `read` of the file, or that one stop, clears the stop.

## Saved side chats

When the main session is saved, each side chat is saved as a pi session file of its own:

```text
~/.pi/agent/side-chats/<main-session-id>/<side-chat-id>.jsonl
```

- **When the file is written.** The extension writes the file when the first message goes out. A side chat that never got a message leaves no file.
- **What the file holds.** The file starts with a copy of what the side chat got from the main thread, so the side chat opens without the main session file. Its header names the main session file.
- **Coming back.** When the main session starts again, for example after `/resume` or `pi -c`, its side chats show in the `/side` list again, with their model and thinking level. A run that was in progress when pi stopped does not continue by itself.
- **Deleting.** In the overlay, `d` and then Yes delete the file. The folder goes too when the file was the last one.
- **Cleanup.** At each session start, the extension deletes side chat files whose main session file is gone, and the folders that become empty. Pi writes a new main session file only after the first reply, so only files older than one hour are deleted.

With `--no-session`, side chats stay in memory and end with the session.
