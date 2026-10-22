// Slice `approvals`: peticiones de permiso de los agentes pendientes de respuesta.
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
  approvals: Approval[];
  addApproval: (approval: Approval) => void;
  /** Responde al core; la tarjeta solo desaparece si la respuesta se entregó. */
  answerApproval: (id: Id, allow: boolean) => Promise<void>;
};

export const createApprovalsSlice: StateCreator<AppState, [], [], ApprovalsSlice> = (set, get) => ({
  approvals: [],
  addApproval: (approval) =>
    set((s) =>
      s.approvals.some((a) => String(a.id) === String(approval.id)) ? s : { approvals: [...s.approvals, approval] },
    ),
  answerApproval: async (id, allow) => {
    const ok = await get().callSafe("approval.answer", { id, allow });
    if (ok === undefined) return;
    set((s) => ({ approvals: s.approvals.filter((a) => String(a.id) !== String(id)) }));
  },
});
