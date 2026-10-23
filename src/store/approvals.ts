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
};

export type ApprovalsSlice = {
  addApproval: (projectId: string, approval: Approval) => void;
  /** Responde al core; la tarjeta solo desaparece si la respuesta se entregó. */
  answerApproval: (projectId: string, id: Id, allow: boolean) => Promise<void>;
};

export const createApprovalsSlice: StateCreator<AppState, [], [], ApprovalsSlice> = (_set, get) => ({
  addApproval: (pid, approval) =>
    get().patchProject(pid, (p) =>
      p.approvals.some((a) => String(a.id) === String(approval.id)) ? null : { approvals: [...p.approvals, approval] },
    ),
  answerApproval: async (pid, id, allow) => {
    const ok = await get().callSafe("approval.answer", { id, allow, projectId: pid });
    if (ok === undefined) return;
    get().patchProject(pid, (p) => ({ approvals: p.approvals.filter((a) => String(a.id) !== String(id)) }));
  },
});
