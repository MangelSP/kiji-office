// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAccessories, saveAccessories } from "./accessories";
import RobotAvatar from "./RobotAvatar";
import { robotSheet } from "./robotSheets";

const ctx = { drawImage: vi.fn(), fillRect: vi.fn(), clearRect: vi.fn(), imageSmoothingEnabled: true, fillStyle: "" };

beforeEach(() => {
  ctx.drawImage.mockClear();
  ctx.fillRect.mockClear();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as never);
  // jsdom no descarga imágenes: se simula la carga.
  vi.stubGlobal(
    "Image",
    class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_v: string) {
        queueMicrotask(() => this.onload?.());
      }
    },
  );
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("RobotAvatar", () => {
  it("las hojas de cada color y la del jefe tienen fotogramas idle", () => {
    for (const k of ["azul", "verde", "crema", "terracota", "terracota-jefe"]) {
      expect(robotSheet(k).url).toBeTruthy();
      expect(robotSheet(k).frames.length).toBeGreaterThan(0);
    }
  });

  it("dibuja el primer fotograma idle pixelado y a escala entera", async () => {
    const { container } = render(<RobotAvatar sheet="terracota-jefe" zoom={2} />);
    const canvas = container.querySelector("canvas")!;
    expect([canvas.width, canvas.height]).toEqual([64, 80]);
    expect(canvas.style.imageRendering).toBe("pixelated");
    await waitFor(() => expect(ctx.drawImage).toHaveBeenCalledTimes(1));
    const first = robotSheet("terracota-jefe").frames[0];
    expect(ctx.drawImage.mock.calls[0].slice(1)).toEqual([first.x, first.y, first.w, first.h, 0, 0, 64, 80]);
    expect(ctx.fillRect).not.toHaveBeenCalled();
  });

  it("con «reducir movimiento» no anima aunque se pida", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<RobotAvatar sheet="azul" animate />);
    await waitFor(() => expect(ctx.drawImage).toHaveBeenCalledTimes(1));
    vi.advanceTimersByTime(1000);
    expect(ctx.drawImage).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("anima el idle si se pide y el sistema lo permite", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    render(<RobotAvatar sheet="azul" animate />);
    await waitFor(() => expect(ctx.drawImage.mock.calls.length).toBeGreaterThan(1), { timeout: 2000 });
    const [a, b] = [ctx.drawImage.mock.calls[0][1], ctx.drawImage.mock.calls[1][1]];
    expect(a).not.toBe(b); // otro fotograma
  });

  it("dibuja los accesorios encima del sprite", async () => {
    render(<RobotAvatar sheet="azul" accessories={["gorra", "lentes", "desconocido"]} />);
    await waitFor(() => expect(ctx.fillRect).toHaveBeenCalled());
    expect(ctx.fillRect.mock.calls.length).toBeGreaterThan(10); // gorra + lentes, nada de "desconocido"
  });

  it("sin hoja conocida cae a un cuadro de color en vez de romperse", async () => {
    const { container } = render(<RobotAvatar sheet="morado" label="Robot" />);
    await waitFor(() => expect(container.querySelectorAll("span span")).toHaveLength(1));
    expect(container.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("Robot");
  });
});

describe("accesorios guardados", () => {
  it("se guardan por agente, se filtran los inválidos y se tolera un localStorage roto", () => {
    saveAccessories("a1", ["gorra", "corbata", "x"]);
    expect(loadAccessories("a1")).toEqual(["gorra", "corbata"]);
    expect(loadAccessories("a2")).toEqual([]);
    saveAccessories("a1", []);
    expect(localStorage.getItem("kiji.accessories.a1")).toBeNull();
    localStorage.setItem("kiji.accessories.a3", "{no json");
    expect(loadAccessories("a3")).toEqual([]);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("cuota");
    });
    expect(() => saveAccessories("a4", ["gorra"])).not.toThrow();
  });
});
