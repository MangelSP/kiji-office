import { describe, expect, it } from "vitest";
import { modelLabel } from "./modelLabel";
import { relayLine, relayNotice } from "./providers";

const conns = [{ id: "c1", name: "LM Studio" }];

describe("modelLabel", () => {
  it("conn:<id>/<modelo> -> nombre · modelo; lo demás queda igual", () => {
    expect(modelLabel("conn:c1/qwen3/coder:7b", conns)).toBe("LM Studio · qwen3/coder:7b");
    expect(modelLabel("conn:zz/x", conns)).toBe("conexión borrada · x");
    expect(modelLabel("sonnet", conns)).toBe("sonnet");
  });

  it("los relevos muestran el nombre de la conexión", () => {
    const row = { id: 1, projectId: "p", taskId: "t", fromAgentId: "a", toAgentId: "a", fromModel: "sonnet", toModel: "conn:c1/qwen", reason: "limit", detail: "", createdAt: 0 } as never;
    const agents = [{ id: "a", name: "Clau" }];
    expect(relayLine(row, agents, conns)).toContain("sonnet → LM Studio · qwen");
    expect(relayNotice(row, agents, conns)).toBe("Clau pasó de sonnet a LM Studio · qwen");
  });
});
