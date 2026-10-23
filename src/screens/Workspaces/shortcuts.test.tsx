// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useStore } from "../../store";
import { resetStore } from "../../store/testing";
import { shortcutTarget, useWorkspaceShortcuts } from "./shortcuts";

function Probe() {
  useWorkspaceShortcuts();
  return null;
}

const key = (k: string, over: Partial<KeyboardEventInit> = {}) =>
  act(() => {
    fireEvent.keyDown(window, { key: k, ...over });
  });

beforeEach(() => {
  resetStore("B");
  useStore.setState({ tabs: ["A", "B", "C"] });
});
afterEach(cleanup);

describe("shortcutTarget", () => {
  const e = (k: string, over = {}) => ({ key: k, metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, ...over });
  it("Cmd/Ctrl+N elige la pestaña N y 0 el Home", () => {
    expect(shortcutTarget(e("1"), ["A", "B"])).toBe("A");
    expect(shortcutTarget(e("2", { metaKey: false, ctrlKey: true }), ["A", "B"])).toBe("B");
    expect(shortcutTarget(e("0"), ["A"])).toBeNull();
  });
  it("ignora teclas sin modificador, con Alt/Shift, letras y pestañas que no existen", () => {
    expect(shortcutTarget(e("1", { metaKey: false }), ["A"])).toBeUndefined();
    expect(shortcutTarget(e("1", { altKey: true }), ["A"])).toBeUndefined();
    expect(shortcutTarget(e("1", { shiftKey: true }), ["A"])).toBeUndefined();
    expect(shortcutTarget(e("a"), ["A"])).toBeUndefined();
    expect(shortcutTarget(e("9"), ["A"])).toBeUndefined();
  });
});

describe("useWorkspaceShortcuts", () => {
  it("Cmd+1 cambia de pestaña, Ctrl+3 a la tercera y Cmd+0 vuelve al Home", () => {
    render(<Probe />);
    key("1", { metaKey: true });
    expect(useStore.getState().activeProjectId).toBe("A");
    key("3", { ctrlKey: true });
    expect(useStore.getState().activeProjectId).toBe("C");
    key("0", { metaKey: true });
    expect(useStore.getState().activeProjectId).toBeNull();
  });

  it("una pestaña inexistente o la tecla suelta no cambian nada", () => {
    render(<Probe />);
    key("9", { metaKey: true });
    key("1");
    expect(useStore.getState().activeProjectId).toBe("B");
  });
});
