import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { copyToClipboard, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type Focusable,
  Input,
  Markdown,
  matchesKey,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { addEmphasisMarkers, removeEmphasisMarkers } from "./emphasis.ts";
import { highlightSelection, isEmptySelection, type Selection, type SelectionPoint, selectionText } from "./selection.ts";
import type { SideChat } from "./sideChat.ts";
import { lastAssistantText, type TranscriptItem } from "./transcript.ts";

/**
 * The side chat overlay: the transcript, the call that waits for approval, the input line, and the keys.
 *
 * Like the pi-recap popup, it has a browse mode with one-letter keys and an input mode for typing,
 * so its keys never clash with the editor's modifier keys. Scrolling is done here rather than with
 * `ScrollView`, because an overlay must also work in regular mode.
 */

/** Share of the terminal height the overlay may take. Matches the `80%` overlay width. */
const HEIGHT_RATIO = 0.8;
/** Top border, blank, blank, separator, footer, bottom border. */
const CHROME_ROWS = 6;
const MIN_BODY_ROWS = 3;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;
const NOTICE_DURATION_MS = 2_500;
const USER_MARKER = "› ";
const BODY_TOP_ROW = 2;
const BODY_LEFT_COLUMN = 2;
const APPROVAL_SUMMARY_MAX_ROWS = 3;

/** A short message in the footer. */
export interface OverlayNotice {
  text: string;
  tone: "success" | "error" | "warning";
}

/** What the overlay asks the extension to do. Each key action that leaves the side chat goes through here. */
export interface SideChatOverlayActions {
  close: () => void;
  delete: () => void;
  /** Queues the side chat for the main thread's next message, or says why not. */
  bringBack: () => OverlayNotice;
  /** Opens the model list over the overlay. Resolves with what to tell the user, if anything. */
  pickModel: () => Promise<OverlayNotice | undefined>;
}

export interface SideChatOverlayOptions {
  tui: TUI;
  theme: Theme;
  keybindings: KeybindingsManager;
  sideChat: SideChat;
  actions: SideChatOverlayActions;
  /** Opens the input line at once, for a side chat that has no message yet. */
  startInInput: boolean;
}

export class SideChatOverlay implements Component, Focusable {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly sideChat: SideChat;
  private readonly actions: SideChatOverlayActions;
  private readonly input: Input;
  private readonly markdownCache = new Map<string, { text: string; markdown: Markdown }>();
  private readonly streamingMarkdown: Markdown;
  private readonly stopListening: () => void;
  private inputOpen = false;
  private hasFocus = false;
  private spinnerFrame = 0;
  private spinnerTimer: ReturnType<typeof setInterval> | undefined;
  private scrollTop = 0;
  /** True while the view follows the newest line. A scroll up by the user ends it. */
  private followBottom = true;
  private viewportHeight = 0;
  private contentHeight = 0;
  private bodyLines: string[] = [];
  private innerWidth = 1;
  private selection: Selection | undefined;
  private selecting = false;
  private notice: { text: string; tone: "success" | "error" | "warning" } | undefined;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  private approvalsSeen = 0;

  constructor(options: SideChatOverlayOptions) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.keybindings = options.keybindings;
    this.sideChat = options.sideChat;
    this.actions = options.actions;
    this.input = new Input({
      prompt: this.theme.fg("accent", USER_MARKER),
      placeholder: "Ask the side chat",
      placeholderStyle: (text) => this.theme.fg("dim", text),
    });
    this.input.onSubmit = (value) => void this.submit(value);
    this.input.onEscape = () => this.closeInput();
    this.streamingMarkdown = new Markdown("", 0, 0, getMarkdownTheme(), undefined, { transform: addEmphasisMarkers });
    this.stopListening = this.sideChat.onChange(() => this.onSideChatChange());
    if (options.startInInput) this.openInput();
    this.onSideChatChange();
  }

  get focused(): boolean {
    return this.hasFocus;
  }

  set focused(value: boolean) {
    this.hasFocus = value;
    this.input.focused = value && this.inputOpen;
  }

  /** Shows a short message in the footer, for example why a key did nothing. */
  showNotice(text: string, tone: "success" | "error" | "warning"): void {
    if (this.noticeTimer !== undefined) clearTimeout(this.noticeTimer);
    this.notice = { text, tone };
    this.noticeTimer = setTimeout(() => {
      this.notice = undefined;
      this.noticeTimer = undefined;
      this.tui.requestRender();
    }, NOTICE_DURATION_MS);
    this.tui.requestRender();
  }

  private onSideChatChange(): void {
    if (this.sideChat.busy) this.startSpinner();
    else this.stopSpinner();
    // A new approval needs the y and n keys, so the input line steps aside and keeps its text.
    const approvals = this.sideChat.approvals.length;
    if (approvals > this.approvalsSeen && this.inputOpen) this.closeInput();
    this.approvalsSeen = approvals;
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (!this.selecting) this.selection = undefined;
    if (this.inputOpen) {
      this.input.handleInput(data);
      this.tui.requestRender();
      return;
    }
    const pageSize = Math.max(1, this.viewportHeight - 1);
    const approvalPending = this.sideChat.approvals.length > 0;
    if (approvalPending && (data === "y" || data === "n")) {
      this.sideChat.answerApproval(data === "y");
    } else if (this.keybindings.matches(data, "tui.select.cancel")) {
      if (this.sideChat.busy) void this.sideChat.abort();
      else this.actions.close();
    } else if (data === "q") {
      this.actions.close();
    } else if (matchesKey(data, "tab") || matchesKey(data, "enter")) {
      this.openInput();
    } else if (data === "p") {
      this.sideChat.togglePermissionMode();
      this.showNotice(
        this.sideChat.mode === "auto"
          ? "Auto: changes run without asking, except in the first run."
          : "Ask: every change waits for your approval.",
        "success",
      );
    } else if (data === "d") {
      this.actions.delete();
    } else if (data === "m") {
      void this.actions.pickModel().then((notice) => {
        if (notice) this.showNotice(notice.text, notice.tone);
      });
    } else if (data === "t") {
      try {
        const level = this.sideChat.cycleThinkingLevel();
        this.showNotice(`Thinking: ${level}, from the next run on.`, "success");
      } catch (error) {
        this.showNotice(error instanceof Error ? error.message : String(error), "warning");
      }
    } else if (data === "b") {
      const notice = this.actions.bringBack();
      this.showNotice(notice.text, notice.tone);
    } else if (data === "c") {
      const text = lastAssistantText(this.sideChat.transcript());
      if (text !== undefined) void this.copy(text);
    } else if (this.keybindings.matches(data, "tui.select.up") || data === "k") {
      this.scrollByUser(-1);
    } else if (this.keybindings.matches(data, "tui.select.down") || data === "j") {
      this.scrollByUser(1);
    } else if (this.keybindings.matches(data, "tui.select.pageUp")) {
      this.scrollByUser(-pageSize);
    } else if (this.keybindings.matches(data, "tui.select.pageDown") || matchesKey(data, "space")) {
      this.scrollByUser(pageSize);
    } else if (matchesKey(data, "home") || data === "g") {
      this.scrollByUser(-this.contentHeight);
    } else if (matchesKey(data, "end") || data === "G") {
      this.scrollByUser(this.contentHeight);
    }
  }

  /** Mouse events come only in fullscreen mode. In regular mode the terminal selects text itself. */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult {
    if (event.type === "wheel") {
      this.scrollByUser(event.wheelDelta ?? 0);
      return { handled: true };
    }
    if (event.type === "press" && event.button === "left") {
      if (!this.isInBody(event)) {
        this.selection = undefined;
        return { handled: true };
      }
      const point = this.bodyPoint(event);
      this.selection = { anchor: point, focus: point };
      this.selecting = true;
      return { capture: true };
    }
    if (event.type === "drag" && this.selecting && this.selection) {
      if (event.y < BODY_TOP_ROW) this.scrollByUser(-1);
      else if (event.y >= BODY_TOP_ROW + this.viewportHeight) this.scrollByUser(1);
      this.selection.focus = this.bodyPoint(event);
      return { handled: true, render: true };
    }
    if (event.type === "release" && this.selecting) {
      this.selecting = false;
      const selection = this.selection;
      if (!selection || isEmptySelection(selection)) this.selection = undefined;
      else void this.copy(selectionText(this.bodyLines, selection), "Copied the selection.");
      return { handled: true, render: true };
    }
    return { handled: true };
  }

  invalidate(): void {
    for (const cached of this.markdownCache.values()) cached.markdown.invalidate();
    this.streamingMarkdown.invalidate();
    this.input.invalidate();
  }

  dispose(): void {
    this.stopListening();
    this.stopSpinner();
    if (this.noticeTimer !== undefined) clearTimeout(this.noticeTimer);
  }

  private async submit(value: string): Promise<void> {
    const result = await this.sideChat.send(value);
    if (result === "busy") {
      this.showNotice("The side chat is starting. Send again in a moment.", "warning");
      return;
    }
    if (result === "empty") return;
    this.input.setValue("");
    this.closeInput();
    this.followBottom = true;
    if (result === "queued") this.showNotice("Queued. It goes to the side chat after this run.", "success");
  }

  private openInput(): void {
    this.inputOpen = true;
    this.input.focused = this.hasFocus;
    this.tui.requestRender();
  }

  private closeInput(): void {
    this.inputOpen = false;
    this.input.focused = false;
    this.tui.requestRender();
  }

  private isInBody(event: TuiMouseEvent): boolean {
    return (
      event.y >= BODY_TOP_ROW &&
      event.y < BODY_TOP_ROW + this.viewportHeight &&
      event.x >= BODY_LEFT_COLUMN &&
      event.x < BODY_LEFT_COLUMN + this.innerWidth
    );
  }

  private bodyPoint(event: TuiMouseEvent): SelectionPoint {
    const viewRow = clamp(event.y - BODY_TOP_ROW, 0, this.viewportHeight - 1);
    return { row: this.scrollTop + viewRow, col: clamp(event.x - BODY_LEFT_COLUMN, 0, this.innerWidth - 1) };
  }

  render(width: number): string[] {
    const theme = this.theme;
    const border = (text: string) => theme.fg("border", text);
    const innerWidth = Math.max(1, width - 4);
    const frameLine = (content: string, rightEdge = border("│")) =>
      `${border("│")} ${truncateToWidth(content, innerWidth, "", true)} ${rightEdge}`;

    const body = this.renderBody(innerWidth);
    const approval = this.renderApproval(innerWidth);
    const inputLines = this.inputOpen ? [this.input.render(innerWidth)[0] ?? ""] : [];
    const chromeRows = CHROME_ROWS + approval.length + inputLines.length;
    const maxBodyRows = Math.max(MIN_BODY_ROWS, Math.floor(this.tui.terminal.rows * HEIGHT_RATIO) - chromeRows);
    this.bodyLines = body;
    this.innerWidth = innerWidth;
    this.contentHeight = body.length;
    this.viewportHeight = Math.min(body.length, maxBodyRows);
    const maxScrollTop = Math.max(0, this.contentHeight - this.viewportHeight);
    if (this.followBottom) this.scrollTop = maxScrollTop;
    this.scrollTop = clamp(this.scrollTop, 0, maxScrollTop);
    const visible = body.slice(this.scrollTop, this.scrollTop + this.viewportHeight);
    const thumb = this.scrollThumb();

    const lines = [this.renderTopBorder(width), frameLine("")];
    visible.forEach((line, row) => {
      const onThumb = thumb !== undefined && row >= thumb.start && row < thumb.start + thumb.size;
      const shown = this.selection ? highlightSelection(line, this.scrollTop + row, this.selection) : line;
      lines.push(frameLine(shown, onThumb ? theme.fg("accent", "┃") : border("│")));
    });
    lines.push(frameLine(""));
    for (const line of approval) lines.push(frameLine(line));
    for (const line of inputLines) lines.push(frameLine(line));
    lines.push(border(`├${"─".repeat(Math.max(0, width - 2))}┤`));
    lines.push(frameLine(this.renderFooter(innerWidth)));
    lines.push(border(`╰${"─".repeat(Math.max(0, width - 2))}╯`));
    return lines;
  }

  private renderBody(innerWidth: number): string[] {
    const theme = this.theme;
    const items = this.sideChat.transcript();
    const lines: string[] = [];
    if (items.length === 0 && !this.sideChat.busy) {
      lines.push(theme.fg("dim", "Ask a question beside the main thread. The main thread keeps working while you ask."));
    }
    for (const item of items) {
      if (item.kind === "user" && lines.length > 0) lines.push("", theme.fg("borderMuted", "─".repeat(innerWidth)), "");
      else if (item.kind === "assistant" && lines.length > 0) lines.push("");
      lines.push(...this.renderItem(item, innerWidth));
    }
    const streaming = this.sideChat.streamingText;
    if (streaming.trim().length > 0) {
      if (lines.length > 0) lines.push("");
      this.streamingMarkdown.setText(streaming);
      lines.push(...this.streamingMarkdown.render(innerWidth).map(removeEmphasisMarkers));
    }
    if (this.sideChat.busy && this.sideChat.approvals.length === 0) {
      const spinner = theme.fg("accent", SPINNER_FRAMES[this.spinnerFrame] ?? "");
      const label = this.sideChat.state === "starting" ? "Starting the side chat…" : "Working…";
      lines.push("", `${spinner} ${theme.fg("muted", label)}`);
    }
    if (this.sideChat.error) lines.push("", ...wrapTextWithAnsi(theme.fg("error", this.sideChat.error), innerWidth));
    return lines;
  }

  private renderItem(item: TranscriptItem, innerWidth: number): string[] {
    const theme = this.theme;
    switch (item.kind) {
      case "user":
        return wrapTextWithAnsi(item.text, Math.max(1, innerWidth - USER_MARKER.length)).map((line, index) => {
          const lead = index === 0 ? theme.fg("accent", USER_MARKER) : " ".repeat(USER_MARKER.length);
          return `${lead}${theme.fg("accent", theme.bold(line))}`;
        });
      case "assistant":
        return this.markdownFor(item.key, item.text).render(innerWidth).map(removeEmphasisMarkers);
      case "tool": {
        const glyph = {
          running: theme.fg("accent", "●"),
          done: theme.fg("success", "✓"),
          error: theme.fg("error", "✗"),
          denied: theme.fg("warning", "⊘"),
          interrupted: theme.fg("muted", "◌"),
        }[item.status];
        const status = item.status === "denied" ? theme.fg("warning", " denied") : item.status === "interrupted" ? theme.fg("muted", " stopped") : "";
        const head = `${glyph} ${theme.bold(item.toolName)} ${theme.fg("muted", item.summary)}`;
        const lines = [truncateToWidth(`${head}${status}`, innerWidth, "…")];
        const errorLine = item.error?.split("\n").find((line) => line.trim().length > 0);
        if (item.status === "error" && errorLine) lines.push(truncateToWidth(`  ${theme.fg("error", errorLine)}`, innerWidth, "…"));
        return lines;
      }
      case "error":
        return wrapTextWithAnsi(theme.fg("error", item.text), innerWidth);
      case "stopped":
        return [theme.fg("muted", "Stopped.")];
    }
  }

  private markdownFor(key: string, text: string): Markdown {
    const cached = this.markdownCache.get(key);
    if (cached && cached.text === text) return cached.markdown;
    const markdown = new Markdown(text, 0, 0, getMarkdownTheme(), undefined, { transform: addEmphasisMarkers });
    this.markdownCache.set(key, { text, markdown });
    return markdown;
  }

  private renderApproval(innerWidth: number): string[] {
    const approval = this.sideChat.approvals[0];
    if (!approval) return [];
    const theme = this.theme;
    const more = this.sideChat.approvals.length - 1;
    const title = `⚠ Approve ${approval.toolName}?${more > 0 ? ` (${more} more waiting)` : ""}`;
    const summary = wrapTextWithAnsi(approval.summary, Math.max(1, innerWidth - 2))
      .slice(0, APPROVAL_SUMMARY_MAX_ROWS)
      .map((line) => `  ${theme.fg("text", line)}`);
    const why = this.sideChat.inContextRun
      ? "The first run of a side chat asks before every change."
      : "The mode is ask. Press p for auto.";
    return [
      theme.fg("warning", theme.bold(title)),
      ...summary,
      `${theme.fg("dim", "y")} ${theme.fg("muted", "approve")}${theme.fg("dim", "  ·  ")}${theme.fg("dim", "n")} ${theme.fg("muted", "deny")}${theme.fg("dim", "  ·  ")}${theme.fg("dim", why)}`,
      "",
    ];
  }

  private renderTopBorder(width: number): string {
    const theme = this.theme;
    const title = theme.fg("accent", theme.bold(` ${this.sideChat.title} `));
    const model = this.sideChat.model?.id ?? "no model";
    const thinking = this.sideChat.thinkingLevel ?? "off";
    const subtitle = theme.fg("muted", ` ${model} · ${thinking} · ${this.sideChat.mode} `);
    const fixedWidth = 4 + visibleWidth(title);
    const showSubtitle = fixedWidth + visibleWidth(subtitle) + 1 <= width;
    const fill = Math.max(0, width - fixedWidth - (showSubtitle ? visibleWidth(subtitle) : 0));
    const border = (text: string) => theme.fg("border", text);
    return truncateToWidth(`${border("╭─")}${title}${border("─".repeat(fill))}${showSubtitle ? subtitle : ""}${border("─╮")}`, width, "");
  }

  private renderFooter(innerWidth: number): string {
    const theme = this.theme;
    const hint = (keys: string, action: string) => `${theme.fg("dim", keys)} ${theme.fg("muted", action)}`;
    const separator = theme.fg("dim", "  ·  ");
    if (this.notice) return theme.fg(this.notice.tone, truncateToWidth(this.notice.text, innerWidth, "…"));
    if (this.inputOpen) {
      const send = this.sideChat.busy ? hint("enter", "send after this run") : hint("enter", "send");
      return truncateToWidth([send, hint("esc", "back")].join(separator), innerWidth, "…");
    }
    const scrollable = this.contentHeight > this.viewportHeight;
    const position = scrollable
      ? theme.fg("dim", `${this.scrollTop + 1}-${this.scrollTop + this.viewportHeight} of ${this.contentHeight}`)
      : "";
    const approve = this.sideChat.approvals.length > 0 ? [hint("y/n", "approve/deny")] : [];
    // While the side chat runs, esc stops it, so q is the way to leave it running in the background.
    const close = this.sideChat.busy ? `${hint("esc", "stop")}${separator}${hint("q", "close")}` : hint("esc", "close");
    const ask = hint("tab", "ask");
    const mode = hint("p", this.sideChat.mode === "ask" ? "auto mode" : "ask mode");
    const model = this.sideChat.busy ? [] : [hint("m", "model"), hint("t", "thinking")];
    const copy = lastAssistantText(this.sideChat.transcript()) !== undefined ? [hint("c", "copy")] : [];
    const remove = hint("d", "delete");
    const bringBack = this.sideChat.busy || copy.length === 0 ? [] : [hint("b", "bring back")];
    const candidates = [
      [...approve, ask, ...bringBack, mode, ...model, ...copy, remove, close],
      [...approve, ask, ...bringBack, mode, ...model, remove, close],
      [...approve, ask, ...bringBack, mode, remove, close],
      [...approve, ask, ...bringBack, close],
      [...approve, ask, close],
      [...approve, close],
    ];
    for (const candidate of candidates) {
      const hints = candidate.join(separator);
      const gap = innerWidth - visibleWidth(hints) - visibleWidth(position);
      if (gap >= 2) return position.length > 0 ? `${hints}${" ".repeat(gap)}${position}` : hints;
    }
    return truncateToWidth(close, innerWidth, "…");
  }

  private scrollThumb(): { start: number; size: number } | undefined {
    if (this.contentHeight <= this.viewportHeight || this.viewportHeight === 0) return undefined;
    const size = Math.max(1, Math.round((this.viewportHeight * this.viewportHeight) / this.contentHeight));
    const maxScrollTop = this.contentHeight - this.viewportHeight;
    const start = Math.round((this.scrollTop / maxScrollTop) * (this.viewportHeight - size));
    return { start, size };
  }

  private scrollByUser(lines: number): void {
    const maxScrollTop = Math.max(0, this.contentHeight - this.viewportHeight);
    const next = clamp(this.scrollTop + lines, 0, maxScrollTop);
    this.followBottom = next >= maxScrollTop;
    if (next === this.scrollTop) return;
    this.scrollTop = next;
    this.tui.requestRender();
  }

  private async copy(text: string, successMessage = "Copied to the clipboard."): Promise<void> {
    try {
      await copyToClipboard(text);
      this.showNotice(successMessage, "success");
    } catch (error) {
      this.showNotice(`Copy failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }

  private startSpinner(): void {
    if (this.spinnerTimer !== undefined) return;
    this.spinnerTimer = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
      this.tui.requestRender();
    }, SPINNER_INTERVAL_MS);
  }

  private stopSpinner(): void {
    if (this.spinnerTimer === undefined) return;
    clearInterval(this.spinnerTimer);
    this.spinnerTimer = undefined;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(Math.max(min, max), value));
}
