import type { ExtensionContext, KeybindingsManager } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, SelectList, truncateToWidth } from "@mariozechner/pi-tui";

export interface ManagementTarget {
  label: string;
  surface: string;
  /** Only subagents have an id; a parent/back target must not be killed. */
  id?: string;
}

export type ManagementAction =
  | { type: "switch"; target: ManagementTarget }
  | { type: "kill"; target: ManagementTarget };

type Theme = ExtensionContext["ui"]["theme"];
const FOOTER = "Enter: switch · Ctrl+K: kill · Esc: cancel";
const MAX_VISIBLE = 10;

/** One picker per interaction; exported so input and rendering can be tested without a TUI. */
export function createManagementPicker(
  targets: readonly ManagementTarget[],
  theme: Theme,
  keybindings: Pick<KeybindingsManager, "matches">,
  done: (result: ManagementAction | undefined) => void,
  requestRender: () => void,
) {
  const items = targets.map((target, index) => ({
    value: String(index),
    label: target.label.replace(/[\r\n]+/g, " ") || target.surface,
  }));
  const list = new SelectList(items, MAX_VISIBLE, {
    selectedPrefix: (text) => theme.fg("accent", text),
    selectedText: (text) => theme.fg("accent", text),
    description: (text) => theme.fg("muted", text),
    scrollInfo: (text) => theme.fg("dim", text),
    noMatch: (text) => theme.fg("muted", text),
  });
  let selectedIndex = 0;
  let finished = false;

  function finish(result: ManagementAction | undefined): void {
    if (finished) return;
    finished = true;
    done(result);
  }

  return {
    render(width: number): string[] {
      const size = Math.max(0, width);
      // SelectList reserves space for its prefix; clamp the width supplied to it
      // and clip all lines (including the footer) at tiny terminal widths.
      return [
        theme.fg("accent", "ZMX sessions"),
        ...list.render(Math.max(4, size)),
        theme.fg("dim", FOOTER),
      ].map((line) => truncateToWidth(line, size, ""));
    },
    invalidate(): void {
      list.invalidate();
    },
    handleInput(data: string): void {
      if (finished) return;
      // Kill is owned by this picker, not the editor's Ctrl+K binding.
      if (matchesKey(data, Key.ctrl("k"))) {
        const target = targets[selectedIndex];
        if (target?.id) finish({ type: "kill", target });
        return;
      }
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || keybindings.matches(data, "tui.select.cancel")) {
        finish(undefined);
        return;
      }
      if (matchesKey(data, Key.enter) || keybindings.matches(data, "tui.select.confirm")) {
        const target = targets[selectedIndex];
        if (target) finish({ type: "switch", target });
        return;
      }
      if (targets.length === 0) return;
      let delta = 0;
      if (keybindings.matches(data, "tui.select.up")) delta = -1;
      else if (keybindings.matches(data, "tui.select.down")) delta = 1;
      else if (keybindings.matches(data, "tui.select.pageUp")) delta = -MAX_VISIBLE;
      else if (keybindings.matches(data, "tui.select.pageDown")) delta = MAX_VISIBLE;
      if (delta !== 0) {
        selectedIndex = (selectedIndex + (delta % targets.length) + targets.length) % targets.length;
        list.setSelectedIndex(selectedIndex);
        requestRender();
      }
    },
  };
}

/** Selection only: callers must confirm and perform any kill or switch themselves. */
export function showManagementPicker(
  ctx: ExtensionContext,
  targets: readonly ManagementTarget[],
): Promise<ManagementAction | undefined> {
  return ctx.ui.custom<ManagementAction | undefined>((tui, theme, keybindings, done) =>
    createManagementPicker(targets, theme, keybindings, done, () => tui.requestRender()),
  );
}
