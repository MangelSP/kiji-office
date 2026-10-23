// Slice `approvals`: peticiones de permiso de los agentes pendientes de respuesta, por proyecto.
import type { StateCreator } from "zustand";
import type { Id } from "./agents";
import type { AppState } from "./index";

export type Approval = {
  id: Id;
  task_id?: Id;
  agent_id?: Id;
  tool?: string;
  input?: unknown;
  risk?: string;
  /** 0.2d: tipo de petición. Si falta, se deduce de `tool` (`manager:*` = del gerente). */
  kind?: "tool" | "question" | "integrate" | "manager";
};

export type ApprovalsSlice = {
  addApproval: (projectId: string, approval: Approval) => void;
  /** Responde al core (`option` = texto exacto de una opción de una pregunta del gerente); la tarjeta solo desaparece si la respuesta se entregó. */
  answerApproval: (projectId: string, id: Id, allow: boolean, option?: string) => Promise<void>;
};

export const createApprovalsSlice: StateCreator<AppState, [], [], ApprovalsSlice> = (_set, get) => ({
  addApproval: (pid, approval) =>
    get().patchProject(pid, (p) =>
      p.approvals.some((a) => String(a.id) === String(approval.id)) ? null : { approvals: [...p.approvals, approval] },
    ),
  answerApproval: async (pid, id, allow, option) => {
    const ok = await get().callSafe("approval.answer", { id, allow, projectId: pid, ...(allow && option !== undefined ? { option } : {}) });
    if (ok === undefined) return;
    get().patchProject(pid, (p) => ({ approvals: p.approvals.filter((a) => String(a.id) !== String(id)) }));
  },
});
