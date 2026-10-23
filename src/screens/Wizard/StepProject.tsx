import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { errorMessage } from "../../store/core";
import { useStore } from "../../store";

type ProjectInfo = { name?: string; path: string; base_branch: string; test_command: string | null };

type Props = {
  /** Se llama cuando el proyecto queda guardado y la persona pulsa «Abrir la oficina». */
  onFinish: () => void;
  blocked: string | null;
};

export default function StepProject({ onFinish, blocked }: Props) {
  const openProject = useStore((s) => s.openProject);
  const call = useStore((s) => s.call);
  const setNotice = useStore((s) => s.setNotice);
  const [info, setInfo] = useState<ProjectInfo | null>(null);
  const [branch, setBranch] = useState("");
  const [testCommand, setTestCommand] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = (p: ProjectInfo) => {
    setInfo(p);
    setBranch(p.base_branch);
    setTestCommand(p.test_command ?? "");
  };

  // Si ya hay un proyecto abierto (asistente reabierto), se parte de él.
  useEffect(() => {
    if (!useStore.getState().project) return;
    call<ProjectInfo | null>("project.get")
      .then((p) => p && load(p))
      .catch(() => undefined);
  }, [call]);

  const choose = async () => {
    setError(null);
    let path: unknown;
    try {
      path = await open({ directory: true, multiple: false, title: "Elige la carpeta del proyecto (un repositorio git)" });
    } catch {
      setError("El selector de carpetas solo está disponible en la app de escritorio.");
      return;
    }
    if (typeof path !== "string") return;
    setBusy(true);
    setNotice(null);
    await openProject(path); // si falla, deja un aviso en el store y no fija el proyecto
    const s = useStore.getState();
    if (s.project?.path !== path) {
      setError(s.notice ?? "No se pudo abrir la carpeta. Debe ser un repositorio git con al menos un commit.");
      setBusy(false);
      return;
    }
    try {
      const p = await call<ProjectInfo>("project.get");
      load({ ...p, name: p.name ?? s.project.name });
    } catch (err) {
      setError(errorMessage(err));
    }
    setBusy(false);
  };

  const finish = async () => {
    setBusy(true);
    setError(null);
    try {
      await call("project.update", { base_branch: branch.trim(), test_command: testCommand.trim() });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
      return;
    }
    setBusy(false);
    onFinish();
  };

  return (
    <section aria-labelledby="wz-project-title">
      <h2 id="wz-project-title">Proyecto</h2>
      <p className="wz-muted">Elige la carpeta (un repositorio git con algún commit) donde trabajarán los robots.</p>

      <button type="button" className="wz-btn wz-btn-primary" onClick={() => void choose()} disabled={busy}>
        {info ? "Cambiar carpeta" : "Elegir carpeta"}
      </button>
      {info && <p className="wz-path wz-small">{info.path}</p>}

      {error && (
        <p className="wz-alert wz-alert-error" role="alert">
          {error}
        </p>
      )}

      {info && (
        <div className="wz-form">
          <div className="wz-field">
            <label htmlFor="wz-branch">Rama base</label>
            <input id="wz-branch" value={branch} onChange={(e) => setBranch(e.target.value)} spellCheck={false} />
            <span className="wz-muted wz-small">Los robots parten de ella y el jefe integra aquí. Debe existir.</span>
          </div>
          <div className="wz-field">
            <label htmlFor="wz-tests">Comando de tests</label>
            <input
              id="wz-tests"
              value={testCommand}
              onChange={(e) => setTestCommand(e.target.value)}
              placeholder="npm test (vacío = sin tests)"
              spellCheck={false}
            />
            <span className="wz-muted wz-small">Se ejecuta en el worktree de cada tarea antes de darla por buena.</span>
          </div>
        </div>
      )}

      {blocked && (
        <p className="wz-alert wz-alert-error" role="alert">
          {blocked} Vuelve al paso 1.
        </p>
      )}
      <div className="wz-footer-inline">
        <button type="button" className="wz-btn wz-btn-primary" disabled={!info || busy || blocked !== null || branch.trim() === ""} onClick={() => void finish()}>
          Abrir la oficina
        </button>
      </div>
    </section>
  );
}
