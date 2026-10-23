// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import ApprovalCard, { approvalVariant, managerQuestion } from "./ApprovalCard";

afterEach(cleanup);

describe("approvalVariant", () => {
  it("deduce la variante de tool y kind", () => {
    expect(approvalVariant({ tool: "Bash" })).toBe("tool");
    expect(approvalVariant({ tool: "manager:ask" })).toBe("manager");
    expect(approvalVariant({ tool: "x", kind: "manager" })).toBe("manager");
    expect(approvalVariant({ tool: "AskUserQuestion", kind: "question" })).toBe("tool");
    expect(approvalVariant({ tool: "manager:request_integration" })).toBe("integrate");
    expect(approvalVariant({ kind: "integrate" })).toBe("integrate");
  });
  it("managerQuestion acepta texto u objeto", () => {
    expect(managerQuestion("¿Sigo?")).toEqual({ question: "¿Sigo?", options: [] });
    expect(managerQuestion({ question: "¿Cómo?", options: ["a", "b", 3] })).toEqual({ question: "¿Cómo?", options: ["a", "b"] });
  });
});

describe("ApprovalCard", () => {
  it("variante herramienta: Permitir / Denegar", async () => {
    const onAnswer = vi.fn(async () => {});
    render(<ApprovalCard approval={{ id: 1, tool: "Bash", input: { command: "ls" } }} agentName="Clau" onAnswer={onAnswer} />);
    expect(screen.getByRole("article", { name: "Permiso pedido: Bash" }).textContent).toContain("Clau pide permiso");
    fireEvent.click(screen.getByRole("button", { name: "Permitir" }));
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith(true));
  });

  it("pregunta del gerente: cabecera propia, un botón por opción y No; nunca Permitir", async () => {
    const onAnswer = vi.fn(async () => {});
    render(
      <ApprovalCard
        approval={{ id: 2, tool: "manager:ask", kind: "manager", input: { question: "¿Sigo gastando?", summary: "s", options: ["Sí, hoy", "Mañana"] } }}
        timeoutMinutes={60}
        onAnswer={onAnswer}
      />,
    );
    const card = screen.getByRole("article", { name: "Pregunta del gerente" });
    expect(card.textContent).toContain("El gerente te pregunta");
    expect(card.textContent).toContain("¿Sigo gastando?");
    expect(card.textContent).toContain("Si no contestas en 60 min se da por NO.");
    expect(card.className).toContain("card-manager");
    expect(screen.queryByText(/Permitir|Denegar/)).toBeNull();
    expect(within(card).getAllByRole("button").map((b) => b.textContent)).toEqual(["Sí, hoy", "Mañana", "No"]);
    fireEvent.click(screen.getByRole("button", { name: "Mañana" }));
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith(true, "Mañana"));
    fireEvent.click(screen.getByRole("button", { name: "No" }));
    await waitFor(() => expect(onAnswer).toHaveBeenLastCalledWith(false));
  });

  it("cada opción de la pregunta del gerente contesta con esa opción", async () => {
    const options = ["Sí, hoy", "Mañana", "Nunca"];
    const onAnswer = vi.fn(async () => {});
    render(<ApprovalCard approval={{ id: 5, tool: "manager:ask_user", input: { question: "¿Cuándo?", options } }} onAnswer={onAnswer} />);
    for (const [i, o] of options.entries()) {
      fireEvent.click(screen.getByRole("button", { name: o }));
      await waitFor(() => expect(onAnswer).toHaveBeenCalledTimes(i + 1));
      expect(onAnswer).toHaveBeenLastCalledWith(true, o);
    }
  });

  it("pregunta de un robot (kind question, sin manager:*): no se muestra como del gerente", () => {
    render(<ApprovalCard approval={{ id: 6, tool: "AskUserQuestion", kind: "question", input: { question: "¿Qué framework?", options: ["a", "b"] } }} agentName="Clau" onAnswer={vi.fn(async () => {})} />);
    expect(screen.queryByRole("article", { name: "Pregunta del gerente" })).toBeNull();
    expect(screen.queryByText(/El gerente te pregunta/)).toBeNull();
    expect(screen.getByRole("article", { name: "Permiso pedido: AskUserQuestion" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Permitir" })).toBeTruthy();
  });

  it("pregunta del gerente sin opciones: Sí / No", async () => {
    const onAnswer = vi.fn(async () => {});
    render(<ApprovalCard approval={{ id: 4, tool: "manager:ask", input: { question: "¿Sigo?", options: [] } }} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole("button", { name: "Sí" }));
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith(true));
    expect(screen.queryByText(/Permitir/)).toBeNull();
  });

  it("variante integrar: nombra la tarea y resalta si viene de un aviso", async () => {
    const onAnswer = vi.fn(async () => {});
    render(<ApprovalCard approval={{ id: 3, tool: "manager:request_integration" }} taskTitle="Login" highlighted onAnswer={onAnswer} />);
    const card = screen.getByRole("article", { name: "Integrar pedido por el gerente" });
    expect(card.textContent).toContain("¿Integro «Login» en la rama principal?");
    expect(card.getAttribute("data-highlighted")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Integrar" }));
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith(true));
  });
});
