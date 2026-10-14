import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@mariozechner/pi-tui";
import {
  createManagementPicker,
  showManagementPicker,
  type ManagementAction,
  type ManagementTarget,
} from "../pi-extension/subagents/management.ts";

const parent: ManagementTarget = { label: "← Back to parent", surface: "parent" };
const first: ManagementTarget = { label: "Agent one", surface: "one", id: "id-one" };
const second: ManagementTarget = { label: "Agent two", surface: "two", id: "id-two" };
const theme = { fg: (_color: string, text: string) => text } as ExtensionContext["ui"]["theme"];

function picker(targets: ManagementTarget[] = [parent, first, second]) {
  const results: (ManagementAction | undefined)[] = [];
  let renders = 0;
  const component = createManagementPicker(
    targets, theme, new KeybindingsManager(TUI_KEYBINDINGS),
    (result) => results.push(result), () => { renders++; },
  );
  return { component, results, get renders() { return renders; } };
}

test("Enter switches to the selected target (including the parent)", () => {
  const { component, results } = picker();
  component.handleInput("\r");
  assert.deepEqual(results, [{ type: "switch", target: parent }]);
});

test("Ctrl+K requests kill only for a target with an id", () => {
  const state = picker();
  state.component.handleInput("\x0b");
  assert.deepEqual(state.results, []);
  state.component.handleInput("\x1b[B");
  state.component.handleInput("\x0b");
  assert.deepEqual(state.results, [{ type: "kill", target: first }]);
  state.component.handleInput("\x0b"); // completed picker does not fire again
  assert.equal(state.results.length, 1);
  assert.equal(state.renders, 1);
});

test("Escape and Ctrl+C cancel without an action", () => {
  for (const key of ["\x1b", "\x03"]) {
    const state = picker();
    state.component.handleInput(key);
    assert.deepEqual(state.results, [undefined]);
  }
});

test("injected selection bindings navigate between targets and keep selection visible", () => {
  const results: (ManagementAction | undefined)[] = [];
  const kb = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.down": "ctrl+n", "tui.select.up": "ctrl+p" });
  const component = createManagementPicker([parent, first, second], theme, kb, (result) => results.push(result), () => {});
  component.handleInput("\x0e");
  component.handleInput("\x0e");
  assert.match(component.render(50).join("\n"), /→ Agent two/);
  component.handleInput("\x10");
  component.handleInput("\r");
  assert.deepEqual(results, [{ type: "switch", target: first }]);
});

test("narrow render lines fit the terminal, including wide labels and footer", () => {
  const state = picker([{ label: "🔧 agent 漢字 with a very long name", surface: "wide", id: "wide" }]);
  for (const width of [0, 1, 2, 4, 12, 30, 80]) {
    const lines = state.component.render(width);
    assert.ok(lines.length >= 3);
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `width ${width}: ${JSON.stringify(lines)}`);
  }
  assert.match(state.component.render(80).at(-1)!, /Enter: switch · Ctrl\+K: kill · Esc: cancel/);
});

test("showManagementPicker delegates to ctx.ui.custom and returns its action", async () => {
  let requested = 0;
  const ctx = {
    ui: {
      custom: async (factory: any) => new Promise((resolve) => {
        const component = factory({ requestRender: () => { requested++; } }, theme, new KeybindingsManager(TUI_KEYBINDINGS), resolve);
        component.handleInput("\x1b[B");
        component.handleInput("\x0b");
      }),
    },
  } as unknown as ExtensionContext;
  assert.deepEqual(await showManagementPicker(ctx, [parent, first]), { type: "kill", target: first });
  assert.equal(requested, 1);
});
