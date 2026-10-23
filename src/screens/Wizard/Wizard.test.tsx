// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));

import { useStore } from "../../store";
import Wizard from "./Wizard";
import type { CliInfo } from "./tauri";
import { nodeProblem } from "./nodeVersion";
import { markWizardDone, readWizardDone } from "./wizardState";

const SECRET = "sk-ant-api03-SUPERSECRETVALUE-wxyz";

const CLIS: CliInfo[] = [
  { name: "claude", found: true, path: "/usr/local/bin/claude", version: "2.1.296" },
  { name: "codex", found: false },
  { name: "agy", found: true, path: "/usr/local/bin/agy", version: "1.3.0" },
  { name: "gemini", found: false },
  { name: "ollama", found: false },
  { name: "node", found: true, path: "/usr/local/bin/node", version: "v22.23.4" },
];

/** Llavero simulado: solo devuelve la máscara, como el comando real. */
let keyring: Record<string, string>;
function fakeInvoke(clis = CLIS) {
  mocks.invoke.mockImplementation(async (cmd: string, args?: any) => {
    switch (cmd) {
      case "detect_clis":
        return clis;
      case "secret_set":
        keyring[args.user] = args.value;
        return;
      case "secret_get":
        return keyring[args.user] ? `…${keyring[args.user].slice(-4)}` : null;
      case "secret_delete":
        delete keyring[args.user];
        return;
      case "core_restart":
        return;
      default:
        return undefined; // core_send: nadie contesta (el cliente expira)
    }
  });
}

beforeEach(() => {
  keyring = {};
  mocks.invoke.mockReset();
  mocks.open.mockReset();
  mocks.listen.mockReset().mockResolvedValue(() => {});
  fakeInvoke();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const goToKeys = async () => {
  render(<Wizard onClose={() => {}} />);
  await screen.findByText("detectado", { selector: ".wz-ok" }).catch(() => undefined);
  fireEvent.click(screen.getByRole("button", { name: /Claves/ }));
  await screen.findByLabelText("Anthropic (Claude)");
};

describe("claves", () => {
  it("el valor escrito no queda en el store, ni en el DOM, ni en logs tras guardar", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    await goToKeys();

    const input = screen.getByLabelText("Anthropic (Claude)") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.autocomplete).toBe("off");

    fireEvent.change(input, { target: { value: SECRET } });
    expect(input.value).toBe(SECRET);
    fireEvent.click(screen.getAllByRole("button", { name: "Guardar" })[0]!);

    await waitFor(() => expect(screen.getByTestId("status-anthropic").textContent).toBe("guardada …wxyz"));
    expect(mocks.invoke).toHaveBeenCalledWith("secret_set", { user: "anthropic", value: SECRET });
    expect(mocks.invoke).toHaveBeenCalledWith("core_restart");
    await screen.findByText(/Clave guardada/);

    // El campo se vacía y el valor no aparece en ningún sitio.
    expect(input.value).toBe("");
    expect(JSON.stringify(useStore.getState(), (_k, v) => (typeof v === "function" ? undefined : v))).not.toContain(SECRET);
    expect(document.body.innerHTML).not.toContain(SECRET);
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain(SECRET);
    // Las peticiones al core (core_send) tampoco la llevan.
    const sent = mocks.invoke.mock.calls.filter(([c]) => c === "core_send");
    expect(JSON.stringify(sent)).not.toContain(SECRET);
  });

  it("borrar: quita la clave y reinicia el core", async () => {
    keyring.openai = "sk-openai-abcdefgh1234";
    await goToKeys();
    await waitFor(() => expect(screen.getByTestId("status-openai").textContent).toBe("guardada …1234"));
    expect(screen.getByTestId("status-anthropic").textContent).toBe("sin clave");

    const openaiBox = screen.getByLabelText("OpenAI").closest("form")!;
    fireEvent.click(openaiBox.querySelector("button[type=button]")!);
    await waitFor(() => expect(screen.getByTestId("status-openai").textContent).toBe("sin clave"));
    expect(mocks.invoke).toHaveBeenCalledWith("secret_delete", { user: "openai" });
    expect(mocks.invoke).toHaveBeenCalledWith("core_restart");
  });

  it("si el llavero falla, no se pierde lo escrito y el error no lleva el valor", async () => {
    await goToKeys();
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "secret_set") throw "llavero no disponible: acceso denegado";
      return cmd === "secret_get" ? null : undefined;
    });
    const input = screen.getByLabelText("Gemini (Google)") as HTMLInputElement;
    fireEvent.change(input, { target: { value: SECRET } });
    fireEvent.click(screen.getAllByRole("button", { name: "Guardar" })[2]!);
    await screen.findByText(/No se pudo guardar: llavero no disponible/);
    expect(document.body.textContent).not.toContain(SECRET);
    expect(JSON.stringify(useStore.getState(), (_k, v) => (typeof v === "function" ? undefined : v))).not.toContain(SECRET);
  });
});

describe("detección", () => {
  it("Node < 22.13: error bloqueante con cómo instalarlo", async () => {
    fakeInvoke(CLIS.map((c) => (c.name === "node" ? { ...c, version: "v20.11.0" } : c)));
    render(<Wizard onClose={() => {}} />);
    const alert = await screen.findByText(/Tu Node es 20\.11\.0/);
    expect(alert.closest("[role=alert]")!.textContent).toMatch(/brew install node@22/);
    expect((screen.getByRole("button", { name: "Siguiente" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /Claves/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("con Node correcto se puede avanzar y se avisa de Gemini por API key", async () => {
    render(<Wizard onClose={() => {}} />);
    await screen.findByText("Node.js");
    expect(screen.queryByText(/Tu Node es/)).toBeNull();
    expect(screen.getAllByText(/Gemini en 0\.1 va por API key/).length).toBeGreaterThanOrEqual(1);
    expect((screen.getByRole("button", { name: "Siguiente" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("fuera de Tauri (invoke falla): avisa y no se rompe ni bloquea", async () => {
    mocks.invoke.mockRejectedValue(new TypeError("Cannot read properties of undefined (reading 'invoke')"));
    render(<Wizard onClose={() => {}} />);
    await screen.findByText(/No se pudo detectar/);
    expect((screen.getByRole("button", { name: "Siguiente" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("nodeProblem y bandera", () => {
  it("comprueba >= 22.13", () => {
    expect(nodeProblem(true, "v22.13.0")).toBeNull();
    expect(nodeProblem(true, "v22.23.4")).toBeNull();
    expect(nodeProblem(true, "v24.0.0")).toBeNull();
    expect(nodeProblem(true, "22.12.9")).toMatch(/22\.12\.9/);
    expect(nodeProblem(true, "v18.19.0")).toMatch(/18\.19\.0/);
    expect(nodeProblem(false, null)).toMatch(/No se encontró/);
    expect(nodeProblem(true, null)).toBeNull();
  });

  it("kiji.wizardDone sobrevive a un localStorage roto", () => {
    expect(readWizardDone()).toBe(false);
    markWizardDone();
    expect(readWizardDone()).toBe(true);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("bloqueado");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("bloqueado");
    });
    expect(readWizardDone()).toBe(false);
    expect(() => markWizardDone()).not.toThrow();
  });
});
