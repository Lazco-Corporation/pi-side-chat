import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type Focusable,
  fuzzyFilter,
  Input,
  type SelectItem,
  SelectList,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { ThinkingLevel } from "./child.ts";

/**
 * The model list of a side chat, and the thinking levels it steps through.
 *
 * The list opens over the side chat overlay. Typing filters it, so a long list of providers stays
 * quick to search, which `ctx.ui.select()` cannot do.
 */

const VISIBLE_ROWS = 10;
/** Model keys such as `<provider>/<group>/<model>` are long, so the key column gets room before the description. */
const MAX_PRIMARY_COLUMN_WIDTH = 56;

export function modelKey(model: Pick<Model<Api>, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

/** The thinking level after `current` among those that `model` supports, wrapping around. */
export function nextThinkingLevel(model: Model<Api>, current: ThinkingLevel | undefined): ThinkingLevel {
  const levels = getSupportedThinkingLevels(model) as ThinkingLevel[];
  const index = current === undefined ? -1 : levels.indexOf(current);
  return levels[(index + 1) % levels.length] ?? "off";
}

export interface ModelPickerOptions {
  theme: Theme;
  keybindings: KeybindingsManager;
  models: readonly Model<Api>[];
  current: Model<Api> | undefined;
  done: (model: Model<Api> | undefined) => void;
}

export class ModelPicker implements Component, Focusable {
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly models: readonly Model<Api>[];
  private readonly current: string | undefined;
  private readonly done: (model: Model<Api> | undefined) => void;
  private readonly input: Input;
  private list: SelectList;
  private matches = 0;
  private hasFocus = false;

  constructor(options: ModelPickerOptions) {
    this.theme = options.theme;
    this.keybindings = options.keybindings;
    this.models = options.models;
    this.current = options.current ? modelKey(options.current) : undefined;
    this.done = options.done;
    this.input = new Input({
      prompt: this.theme.fg("accent", "› "),
      placeholder: "Filter models",
      placeholderStyle: (text) => this.theme.fg("dim", text),
    });
    this.list = this.buildList("");
  }

  get focused(): boolean {
    return this.hasFocus;
  }

  set focused(value: boolean) {
    this.hasFocus = value;
    this.input.focused = value;
  }

  private buildList(filter: string): SelectList {
    const items: SelectItem[] = this.models.map((model) => {
      const key = modelKey(model);
      return { value: key, label: key, description: key === this.current ? "current" : model.name };
    });
    const filtered = filter.trim().length === 0 ? items : fuzzyFilter(items, filter, (item) => item.value);
    this.matches = filtered.length;
    const widest = Math.max(0, ...items.map((item) => visibleWidth(item.label)));
    const primaryWidth = Math.min(widest + 2, MAX_PRIMARY_COLUMN_WIDTH);
    const list = new SelectList(filtered, VISIBLE_ROWS, getSelectListTheme(), {
      minPrimaryColumnWidth: primaryWidth,
      maxPrimaryColumnWidth: primaryWidth,
    });
    const currentIndex = filtered.findIndex((item) => item.value === this.current);
    if (currentIndex >= 0 && filter.trim().length === 0) list.setSelectedIndex(currentIndex);
    list.onSelect = (item) => this.done(this.models.find((model) => modelKey(model) === item.value));
    list.onCancel = () => this.done(undefined);
    return list;
  }

  handleInput(data: string): void {
    const listKeys = ["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel", "tui.select.pageUp", "tui.select.pageDown"] as const;
    if (listKeys.some((key) => this.keybindings.matches(data, key))) {
      this.list.handleInput(data);
      return;
    }
    const before = this.input.getValue();
    this.input.handleInput(data);
    const after = this.input.getValue();
    if (after !== before) this.list = this.buildList(after);
  }

  invalidate(): void {
    this.input.invalidate();
    this.list.invalidate();
  }

  render(width: number): string[] {
    const theme = this.theme;
    const border = (text: string) => theme.fg("border", text);
    const innerWidth = Math.max(1, width - 4);
    const frameLine = (content: string) => `${border("│")} ${truncateToWidth(content, innerWidth, "", true)} ${border("│")}`;
    const title = theme.fg("accent", theme.bold(" Side chat model "));
    const top = `${border("╭─")}${title}${border("─".repeat(Math.max(0, width - 4 - visibleWidth(title))))}${border("─╮")}`;
    const listLines = this.list.render(innerWidth);
    const hints = theme.fg("dim", "type to filter  ·  ↑↓ move  ·  enter choose  ·  esc cancel");
    return [
      truncateToWidth(top, width, ""),
      frameLine(this.input.render(innerWidth)[0] ?? ""),
      frameLine(""),
      ...(this.matches === 0 ? [frameLine(theme.fg("muted", "No model matches."))] : listLines.map(frameLine)),
      frameLine(""),
      frameLine(hints),
      border(`╰${"─".repeat(Math.max(0, width - 2))}╯`),
    ];
  }
}
