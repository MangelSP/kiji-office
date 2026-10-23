// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../core/client", () => ({
  core: { request: vi.fn(), start: vi.fn(), onEvent: vi.fn(() => () => {}) },
  CoreError: class CoreError extends Error {},
}));

import { useSettings } from "../../store/settings";
import { greeting, useGreeting } from "./greeting";

function Probe() {
  return <h1>{useGreeting()}</h1>;
}
const withName = (value: string | null) =>
  useSettings.setState({ specs: { user_name: { key: "user_name", value, default: "Alexis", section: "general" } }, status: "ready" });

afterEach(cleanup);

describe("saludo", () => {
  it("usa user_name y el momento del día", () => {
    expect(greeting(9, "Marta")).toBe("¡Buenos días, Marta!");
    expect(greeting(15, " Marta ")).toBe("¡Buenas tardes, Marta!");
    expect(greeting(22, "Marta")).toBe("¡Buenas noches, Marta!");
  });
  it("sin nombre: «¡Hola!»", () => {
    expect(greeting(9, "")).toBe("¡Hola!");
    expect(greeting(9, "   ")).toBe("¡Hola!");
    expect(greeting(9, undefined)).toBe("¡Hola!");
  });
  it("el componente lee el ajuste (valor, defecto o vacío)", () => {
    withName("Marta");
    render(<Probe />);
    expect(screen.getByRole("heading").textContent).toMatch(/^¡Buen.+, Marta!$/);
    cleanup();
    withName(null);
    render(<Probe />);
    expect(screen.getByRole("heading").textContent).toContain("Alexis");
    cleanup();
    withName("");
    render(<Probe />);
    expect(screen.getByRole("heading").textContent).toBe("¡Hola!");
  });
});
