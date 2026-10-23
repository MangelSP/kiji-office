// Cola de animaciones de la pizarra por proyecto: `board.moved` se guarda en `byProject[pid].boardMoves` y la escena
// consume lo que no ha visto (por `seq`).
import type { BoardMovedEvent } from "../../shared/protocol";
import { useStore } from ".";

export type BoardMoveItem = BoardMovedEvent & { seq: number };

const MAX_MOVES = 50;
let seq = 0;

export function pushBoardMove(projectId: string, ev: BoardMovedEvent) {
  const item: BoardMoveItem = { ...ev, projectId, seq: ++seq };
  useStore.getState().patchProject(projectId, (p) => ({ boardMoves: [...p.boardMoves, item].slice(-MAX_MOVES) }));
}
