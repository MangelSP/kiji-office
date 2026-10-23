// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../core/client", () => ({
  core: { request: mocks.request, start: vi.fn(), onEvent: vi.fn(() => () => {}) },
  CoreError: class CoreError extends Error {},
}));

import { applyEvent, useStore } from "../store";
import { resetStore } from "../store/testing";
import StopAllButton, { HaltedBanner } from "./StopAllButton";

const calls = (m: string) => mocks.request.mock.calls.filter((c) => c[0] === m);

beforeEach(() => {
  mocks.request.mockReset();
  mocks.request.mockImplementation(async (m: string) => (m === "manager.stopAll" ? { halted: true } : m === "manager.resume" ? { halted: false } : null));
  resetStore();
});
afterEach(cleanup);

describe("StopAllButton", () => {
  it("pide confirmación y solo entonces llama a manager.stopAll", async () => {
    render(<StopAllButton />);
    fireEvent.click(screen.getByRole("button", { name: "Parar todo" }));
    expect(calls("manager.stopAll")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Parar todo" }));
    fireEvent.click(screen.getByRole("button", { name: "Sí, parar todo" }));
    await waitFor(() => expect(calls("manager.stopAll")).toHaveLength(1));
    await waitFor(() => expect(useStore.getState().halted).toBe(true));
  });

  it("parado: el botón queda desactivado y sale el banner con Reanudar", async () => {
    render(
      <>
        <StopAllButton />
        <HaltedBanner />
      </>,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    act(() => applyEvent({ type: "event", name: "manager.halted", payload: { halted: true } }));
    expect((screen.getByRole("button", { name: "Parado" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(screen.getByRole("alert")).getByText("Todo parado")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reanudar" }));
    await waitFor(() => expect(calls("manager.resume")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});
