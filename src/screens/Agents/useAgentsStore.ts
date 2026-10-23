// Acceso al store acotado al proyecto de la oficina (ver `store/scoped.ts`); los componentes de agentes lo usan
// como si el estado fuera de un solo proyecto.
export { useScoped as useAgentsStore } from "../../store/scoped";
export type { ScopedState as AgentsState } from "../../store/scoped";
