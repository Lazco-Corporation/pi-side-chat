import { randomUUID } from "node:crypto";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type ExtensionFactory,
  type ModelRegistry,
  type SessionEntry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { DENIED_REASON, describeToolCall, needsApproval, nextPermissionMode, type PermissionMode } from "./approval.ts";
import { CHANGE_TOOL_NAMES, resolveToolPath } from "./changes.ts";
import { createChildSession, type ThinkingLevel } from "./child.ts";
import { buildSideChatContext } from "./context.ts";
import { activitySince, type ForkPoint } from "./fork.ts";
import { createMainThreadReadTool } from "./mainThreadRead.ts";
import { streamingText, type TranscriptItem, transcriptFromEntries } from "./transcript.ts";

/**
 * One side chat: its agent session, its permission mode, and the tool calls that wait for the user.
 *
 * The agent session starts with the first message, so a side chat that the user opens and closes
 * without a message costs nothing.
 */

/** The custom entry that ends the inherited part of a side chat session. */
export const SIDE_CHAT_ENTRY_TYPE = "side-chat";
/** The custom message that carries the side chat context with the first question. */
export const SIDE_CHAT_CONTEXT_TYPE = "side-chat-context";
export const DEFAULT_TITLE = "Side chat";
const TITLE_MAX_CHARS = 60;

/** What a side chat reads from the main session. */
export interface MainThread {
  readonly cwd: string;
  readonly modelRegistry: ModelRegistry;
  branch(): SessionEntry[];
  isIdle(): boolean;
  systemPrompt(): string;
}

export type SideChatState = "draft" | "starting" | "running" | "approval" | "idle";

export interface PendingApproval {
  toolName: string;
  summary: string;
  resolve: (approved: boolean) => void;
}

/** What the extension learns from a side chat as it runs. */
export interface SideChatHooks {
  /** A side chat `edit` or `write` succeeded. */
  fileChanged(sideChat: SideChat, absolutePath: string): void;
  /** A run ended that changed these files. */
  runChangedFiles(sideChat: SideChat, absolutePaths: string[]): void;
}

export interface SideChatOptions {
  id?: string;
  fork: ForkPoint;
  main: MainThread;
  model: Model<Api> | undefined;
  thinkingLevel: ThinkingLevel | undefined;
  hooks: SideChatHooks;
}

export type SendResult = "sent" | "queued" | "busy" | "empty";

/** The first line of the first question, short enough for a title bar. */
export function titleFromQuestion(question: string): string {
  const line = question.trim().split("\n")[0]?.replace(/\s+/g, " ") ?? "";
  if (line.length === 0) return DEFAULT_TITLE;
  return line.length <= TITLE_MAX_CHARS ? line : `${line.slice(0, TITLE_MAX_CHARS - 1)}…`;
}

export class SideChat {
  readonly id: string;
  title = DEFAULT_TITLE;
  mode: PermissionMode = "ask";
  /** Set when the last attempt to start or run the side chat failed. */
  error: string | undefined;
  readonly approvals: PendingApproval[] = [];
  private readonly fork: ForkPoint;
  private readonly main: MainThread;
  private readonly hooks: SideChatHooks;
  /** Files that the current run changed, in the order of their first change. */
  private readonly runChanges = new Set<string>();
  private draftModel: Model<Api> | undefined;
  private draftThinkingLevel: ThinkingLevel | undefined;
  private session: AgentSession | undefined;
  private sessionStart: Promise<AgentSession> | undefined;
  private contextDelivered = false;
  /** True during the run that carries the side chat context: every change asks first then. */
  private contextRun = false;
  /** True from a send until the run settles. */
  private runActive = false;
  private streamingMessage: unknown;
  private disposed = false;
  private readonly listeners = new Set<() => void>();
  private transcriptCache: { version: number; items: TranscriptItem[] } | undefined;
  private version = 0;
  private unsubscribe: (() => void) | undefined;

  constructor(options: SideChatOptions) {
    this.id = options.id ?? randomUUID();
    this.fork = options.fork;
    this.main = options.main;
    this.hooks = options.hooks;
    this.draftModel = options.model;
    this.draftThinkingLevel = options.thinkingLevel;
  }

  /** Called on every change that the overlay draws. Returns the function that stops it. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get state(): SideChatState {
    if (this.approvals.length > 0) return "approval";
    if (this.runActive) return this.session ? "running" : "starting";
    return this.session ? "idle" : "draft";
  }

  get busy(): boolean {
    return this.runActive;
  }

  /** True during the run that carries the side chat context. */
  get inContextRun(): boolean {
    return this.contextRun;
  }

  get model(): Model<Api> | undefined {
    return this.session?.model ?? this.draftModel;
  }

  get thinkingLevel(): ThinkingLevel | undefined {
    return this.session?.thinkingLevel ?? this.draftThinkingLevel;
  }

  /** True once the user sent a message. A side chat without one is dropped when it closes. */
  get hasMessages(): boolean {
    return this.runActive || this.ownEntries().some((entry) => entry.type === "message");
  }

  /** The text of the reply that the model writes now. Empty when it writes none. */
  get streamingText(): string {
    return streamingText(this.streamingMessage);
  }

  transcript(): TranscriptItem[] {
    if (this.transcriptCache?.version !== this.version) {
      this.transcriptCache = { version: this.version, items: transcriptFromEntries(this.ownEntries(), this.runActive) };
    }
    return this.transcriptCache.items;
  }

  /** The entries after the marker that ends the inherited part. */
  ownEntries(): SessionEntry[] {
    if (!this.session) return [];
    const branch = this.session.sessionManager.getBranch();
    const markerIndex = branch.findIndex((entry) => entry.type === "custom" && entry.customType === SIDE_CHAT_ENTRY_TYPE);
    return branch.slice(markerIndex + 1);
  }

  togglePermissionMode(): void {
    this.mode = nextPermissionMode(this.mode);
    this.changed();
  }

  /** Sends a message. While the side chat runs, the message waits for the run to end. */
  async send(text: string): Promise<SendResult> {
    const message = text.trim();
    if (message.length === 0) return "empty";
    if (this.runActive) {
      if (!this.session?.isStreaming) return "busy";
      await this.session.prompt(message, { streamingBehavior: "followUp" });
      return "queued";
    }
    if (this.title === DEFAULT_TITLE) this.title = titleFromQuestion(message);
    this.error = undefined;
    this.runActive = true;
    this.changed();
    void this.run(message);
    return "sent";
  }

  private async run(message: string): Promise<void> {
    try {
      const session = await this.ensureSession();
      if (!this.contextDelivered) {
        this.contextDelivered = true;
        this.contextRun = true;
        // The context rides with the question as a hidden message, so the question stays the user's own text.
        await session.sendCustomMessage(
          {
            customType: SIDE_CHAT_CONTEXT_TYPE,
            content: buildSideChatContext({
              activity: activitySince(this.main.branch(), this.fork.leafId),
              toolNames: session.getActiveToolNames(),
            }),
            display: false,
          },
          { deliverAs: "nextTurn" },
        );
      }
      await session.prompt(message);
    } catch (error) {
      if (!this.disposed) this.error = error instanceof Error ? error.message : String(error);
    } finally {
      // A failed start never settles, so the run ends here too.
      if (!this.session?.isStreaming) this.endRun();
    }
  }

  /** Stops the run. Calls that wait for the user count as denied. */
  async abort(): Promise<void> {
    this.denyAll();
    await this.session?.abort();
  }

  answerApproval(approved: boolean): void {
    const approval = this.approvals.shift();
    if (!approval) return;
    approval.resolve(approved);
    this.changed();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.denyAll();
    this.unsubscribe?.();
    const session = this.session;
    this.session = undefined;
    if (session) void session.abort().finally(() => session.dispose());
    this.listeners.clear();
  }

  private denyAll(): void {
    for (const approval of this.approvals.splice(0)) approval.resolve(false);
  }

  private ensureSession(): Promise<AgentSession> {
    this.sessionStart ??= this.startSession();
    return this.sessionStart;
  }

  private async startSession(): Promise<AgentSession> {
    const sessionManager = SessionManager.inMemory(this.main.cwd, { id: this.id }, structuredClone(this.fork.inherited));
    sessionManager.appendCustomEntry(SIDE_CHAT_ENTRY_TYPE, { id: this.id, forkLeafId: this.fork.leafId });
    const session = await createChildSession({
      cwd: this.main.cwd,
      systemPrompt: this.main.systemPrompt(),
      sessionManager,
      model: this.draftModel,
      thinkingLevel: this.draftThinkingLevel,
      modelRegistry: this.main.modelRegistry,
      gate: this.gate,
      customTools: [
        createMainThreadReadTool(() => ({
          running: !this.main.isIdle(),
          activity: activitySince(this.main.branch(), this.fork.leafId),
        })),
      ],
    });
    if (this.disposed) {
      session.dispose();
      throw new Error("The side chat was closed.");
    }
    this.session = session;
    this.unsubscribe = session.subscribe((event) => {
      switch (event.type) {
        case "message_update":
          if (event.message.role === "assistant") this.streamingMessage = event.message;
          this.notify();
          break;
        case "message_end":
          this.streamingMessage = undefined;
          this.changed();
          break;
        case "entry_appended":
        case "tool_execution_start":
        case "tool_execution_end":
          this.changed();
          break;
        case "agent_settled":
          this.endRun();
          break;
      }
    });
    return session;
  }

  private endRun(): void {
    this.runActive = false;
    this.contextRun = false;
    this.streamingMessage = undefined;
    this.denyAll();
    if (this.runChanges.size > 0) {
      const paths = [...this.runChanges];
      this.runChanges.clear();
      this.hooks.runChangedFiles(this, paths);
    }
    this.changed();
  }

  /** The side chat's own extension: it holds every change for the user's answer when the mode asks for it. */
  private readonly gate: ExtensionFactory = (childPi) => {
    childPi.on("tool_call", async (event) => {
      if (!needsApproval(event.toolName, this.mode, this.contextRun)) return undefined;
      const approved = await this.requestApproval(event.toolName, event.input);
      return approved ? undefined : { block: true, reason: DENIED_REASON };
    });
    childPi.on("tool_result", async (event) => {
      if (event.isError || !CHANGE_TOOL_NAMES.has(event.toolName)) return undefined;
      const path = resolveToolPath(this.main.cwd, event.input);
      if (path === undefined) return undefined;
      this.runChanges.add(path);
      this.hooks.fileChanged(this, path);
      return undefined;
    });
  };

  private requestApproval(toolName: string, input: unknown): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    return new Promise((resolve) => {
      this.approvals.push({ toolName, summary: describeToolCall(toolName, input), resolve });
      this.changed();
    });
  }

  /** A change to the entries or the state: the transcript is built again. */
  private changed(): void {
    this.version++;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
