import { randomUUID } from "node:crypto";
import { type Api, clampThinkingLevel, type Model } from "@earendil-works/pi-ai";
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
import { SIDE_CHAT_ENTRY_TYPE, type SideChatMarker, storeSession } from "./store.ts";
import { modelKey, nextThinkingLevel } from "./modelPicker.ts";
import { streamingText, type TranscriptItem, transcriptFromEntries } from "./transcript.ts";

/**
 * One side chat: its agent session, its permission mode, and the tool calls that wait for the user.
 *
 * The agent session starts with the first message, so a side chat that the user opens and closes
 * without a message costs nothing.
 */

/** The custom message that carries the side chat context with the first question. */
export const SIDE_CHAT_CONTEXT_TYPE = "side-chat-context";
export const DEFAULT_TITLE = "Side chat";
export const BUSY_SETTING_MESSAGE = "Wait for this run to end, or press esc to stop it.";
const TITLE_MAX_CHARS = 60;

/** What a side chat reads from the main session. */
export interface MainThread {
  readonly cwd: string;
  /** The main session file, which a stored side chat names. Undefined when the main session is not saved. */
  readonly sessionFile: string | undefined;
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

/** A side chat read back from its file. */
export interface StoredSideChatSource {
  marker: SideChatMarker;
  sessionManager: SessionManager;
}

export interface SideChatOptions {
  fork: ForkPoint;
  /** Set for a side chat read back from disk; `fork` then holds no inherited entries. */
  stored?: StoredSideChatSource;
  /** Where to save the side chat when its first message goes out. Undefined keeps it in memory. */
  storeDir?: string;
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
  private readonly storeDir: string | undefined;
  private draftModel: Model<Api> | undefined;
  private draftThinkingLevel: ThinkingLevel | undefined;
  private sessionManager: SessionManager | undefined;
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
    this.id = options.stored?.marker.id ?? randomUUID();
    this.fork = options.fork;
    this.storeDir = options.storeDir;
    if (options.stored) {
      this.title = options.stored.marker.title;
      this.sessionManager = options.stored.sessionManager;
      this.contextDelivered = true;
    }
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
    return this.sessionManager ? "idle" : "draft";
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
    return this.runActive || this.transcript().some((item) => item.kind === "user");
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

  /** The file of a saved side chat. Undefined while it is in memory only. */
  get path(): string | undefined {
    return this.sessionManager?.getSessionFile();
  }

  /** The entries after the marker that ends the inherited part. */
  ownEntries(): SessionEntry[] {
    if (!this.sessionManager) return [];
    const branch = this.sessionManager.getBranch();
    const markerIndex = branch.findIndex((entry) => entry.type === "custom" && entry.customType === SIDE_CHAT_ENTRY_TYPE);
    return branch.slice(markerIndex + 1);
  }

  /**
   * Changes the model from the next run on. The thinking level stays, or becomes the nearest level
   * that the new model supports. Throws when the side chat runs or the model has no key or login.
   */
  async setModel(model: Model<Api>): Promise<void> {
    if (this.runActive) throw new Error(BUSY_SETTING_MESSAGE);
    const level = this.thinkingLevel;
    const keptLevel = level === undefined ? undefined : (clampThinkingLevel(model, level) as ThinkingLevel);
    if (this.session) {
      await this.session.setModel(model);
      if (keptLevel !== undefined) this.session.setThinkingLevel(keptLevel);
    } else {
      if (!this.main.modelRegistry.hasConfiguredAuth(model)) throw new Error(`No API key or login for ${modelKey(model)}.`);
      this.draftModel = model;
      this.draftThinkingLevel = keptLevel;
    }
    this.changed();
  }

  /** Steps to the next thinking level that the model supports, from the next run on. */
  cycleThinkingLevel(): ThinkingLevel {
    if (this.runActive) throw new Error(BUSY_SETTING_MESSAGE);
    const model = this.model;
    if (!model) throw new Error("Choose a model first.");
    const next = nextThinkingLevel(model, this.thinkingLevel);
    if (this.session) this.session.setThinkingLevel(next);
    else this.draftThinkingLevel = next;
    this.changed();
    return next;
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
    // A failed start is tried again with the next message, instead of failing every message after it.
    this.sessionStart ??= this.startSession().catch((error: unknown) => {
      this.sessionStart = undefined;
      throw error;
    });
    return this.sessionStart;
  }

  private async startSession(): Promise<AgentSession> {
    const sessionManager = this.sessionManager ?? this.seedSessionManager();
    this.sessionManager = sessionManager;
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

  /** The inherited entries and the marker, saved to a file when the side chat has a place on disk. */
  private seedSessionManager(): SessionManager {
    const seed = SessionManager.inMemory(
      this.main.cwd,
      { id: this.id, ...(this.main.sessionFile ? { parentSession: this.main.sessionFile } : {}) },
      structuredClone(this.fork.inherited),
    );
    const marker: SideChatMarker = { id: this.id, title: this.title, forkLeafId: this.fork.leafId };
    seed.appendCustomEntry(SIDE_CHAT_ENTRY_TYPE, marker);
    // The session name makes the file readable in pi's own session tools, instead of the main session's name.
    seed.appendSessionInfo(this.title);
    return this.storeDir ? storeSession(seed, this.storeDir) : seed;
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
