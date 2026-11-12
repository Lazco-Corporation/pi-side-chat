import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import type { SideChatState } from "./sideChat.ts";

/**
 * What the main screen shows about the side chats while their overlays are closed: a widget above
 * the editor with one row for each side chat, and a footer note when one waits for an approval.
 */

export const MAX_WIDGET_ROWS = 5;

type Tone = "warning" | "accent" | "success" | "muted";

export interface StatusLabel {
  text: string;
  tone: Tone;
}

/** `unread` is set when a run ended while the side chat's overlay was closed. */
export function stateLabel(state: SideChatState, unread: boolean): StatusLabel {
  switch (state) {
    case "approval":
      return { text: "waits for approval", tone: "warning" };
    case "starting":
      return { text: "starting", tone: "accent" };
    case "running":
      return { text: "running", tone: "accent" };
    case "idle":
      return unread ? { text: "new reply", tone: "success" } : { text: "idle", tone: "muted" };
    case "draft":
      return { text: "empty", tone: "muted" };
  }
}

export interface StatusRow {
  title: string;
  label: StatusLabel;
}

/** The text that the widget shows, so the widget is set again only when it changes. */
export function statusKey(rows: readonly StatusRow[]): string {
  return rows.map((row) => `${row.title}\u0000${row.label.text}`).join("\u0001");
}

export function widgetLines(rows: readonly StatusRow[], theme: Theme, width: number): string[] {
  const shown = rows.slice(0, MAX_WIDGET_ROWS);
  const lines = [theme.fg("muted", `Side chats (${rows.length}) · /side to open`)];
  for (const row of shown) {
    lines.push(`  ${theme.fg(row.label.tone, "◆")} ${row.title} ${theme.fg("dim", "·")} ${theme.fg(row.label.tone, row.label.text)}`);
  }
  if (rows.length > shown.length) lines.push(theme.fg("dim", `  +${rows.length - shown.length} more`));
  return lines.map((line) => truncateToWidth(line, width, "…"));
}

/** The widget draws with the theme of each render, so a theme change recolors it. */
export function statusWidget(rows: readonly StatusRow[]): (tui: unknown, theme: Theme) => Component {
  return (_tui, theme) => ({
    render: (width: number) => widgetLines(rows, theme, width),
    invalidate: () => {},
  });
}

export function approvalNote(title: string): string {
  return `Side chat "${title}" waits for approval. Run /side to answer.`;
}
