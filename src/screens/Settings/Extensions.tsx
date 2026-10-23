// Skills y MCP de Claude Code instalados (global, por proyecto y de plugins) con opción de desinstalarlos.
// Gestiona la configuración de Claude Code del usuario, no la de los robots de Kiji.
import { useEffect, useId, useState } from "react";
import type { McpEntry, SkillEntry } from "../../../shared/protocol";
import { useStore } from "../../store";
import { connectExtensions, useExtensions } from "../../store/extensions";

type Tab = "skills" | "mcp";
type Item = ({ kind: "mcp" } & McpEntry) | ({ kind: "skill" } & SkillEntry);

const SCOPE_LABEL: Record<string, string> = { user: "Global", local: "Proyecto (local)", project: "Proyecto", plugin: "Plugin" };

function inScope(e: { scope: string; projectId: string | null }, filter: string): boolean {
  if (filter === "all") return true;
  if (filter === "global") return e.scope === "user" || e.scope === "plugin";
  return e.projectId === filter;
}

/** Qué se va a tocar exactamente, para la confirmación. */
function describeChange(it: Item): { target: string; how: string } {
  if (it.kind === "mcp") {
    const proj = it.scope === "local" ? ` (sección de este proyecto)` : "";
    return {
      target: `${it.source}${proj}`,
      how: `Se quitará solo la entrada «${it.name}» de ese archivo. Antes se guarda una copia de seguridad junto a él (<archivo>.kiji-backup-<fecha>).`,
    };
  }
  return it.isSymlink
    ? { target: it.path, how: `Es un enlace simbólico${it.target ? ` hacia ${it.target}` : ""}: se quita solo el enlace; el destino no se toca.` }
    : { target: it.path, how: "La carpeta se mueve a la papelera del sistema (no se borra) y podrás recuperarla desde ahí." };
}

function Confirm({ item, busy, error, onCancel, onOk }: { item: Item; busy: boolean; error: string | null; onCancel: () => void; onOk: () => void }) {
  const id = useId();
  const { target, how } = describeChange(item);
  return (
    <div className="st-modal" role="dialog" aria-modal="true" aria-labelledby={`${id}-t`}>
      <div className="st-modal-box">
        <h3 id={`${id}-t`}>
          Desinstalar {item.kind === "mcp" ? "el MCP" : "la skill"} «{item.name}»
        </h3>
        <p>
          Se modificará: <code>{target}</code>
        </p>
        <p>{how}</p>
        <p className="st-hint">Claude Code puede necesitar reiniciarse (o abrir una sesión nueva) para dejar de usarlo.</p>
        {error && (
          <p className="st-error" role="alert">
            {error}
          </p>
        )}
        <div className="st-controls">
          <button type="button" className="st-btn" onClick={onCancel} disabled={busy}>
            Cancelar
          </button>
          <button type="button" className="st-btn st-btn-primary" onClick={onOk} disabled={busy}>
            {busy ? "Desinstalando…" : "Desinstalar"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Extensions({ initialTab = "skills" }: { initialTab?: Tab }) {
  const data = useExtensions((s) => s.data);
  const error = useExtensions((s) => s.error);
  const loading = useExtensions((s) => s.loading);
  const load = useExtensions((s) => s.load);
  const remove = useExtensions((s) => s.remove);
  const projects = useStore((s) => s.projects).filter((p) => p.open);
  const [tab, setTab] = useState<Tab>(initialTab);
  const [filter, setFilter] = useState("all");
  const [pending, setPending] = useState<Item | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    void load();
    return connectExtensions();
  }, [load]);

  const name = (projectId: string | null) => projects.find((p) => p.projectId === projectId)?.name;
  const items: Item[] = data
    ? tab === "mcp"
      ? data.mcp.filter((e) => inScope(e, filter)).map((e) => ({ kind: "mcp" as const, ...e }))
      : data.skills.filter((e) => inScope(e, filter)).map((e) => ({ kind: "skill" as const, ...e }))
    : [];

  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    setFailure(null);
    const r = await remove({ kind: pending.kind, scope: pending.scope, name: pending.name, projectId: pending.projectId ?? undefined });
    setBusy(false);
    if ("error" in r) return setFailure(r.error);
    const { backup, trashPath } = r.result;
    setDone(
      `«${pending.name}» desinstalado. ` +
        (backup ? `Copia de seguridad: ${backup}. ` : "") +
        (trashPath ? `Está en la papelera: ${trashPath}. ` : pending.kind === "skill" ? "Se quitó el enlace. " : "") +
        "Reinicia Claude Code si lo tienes abierto.",
    );
    setPending(null);
  };

  return (
    <div className="st-field">
      <div className="st-tabs" role="tablist" aria-label="Tipo de extensión">
        {(["skills", "mcp"] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={`st-tab${tab === t ? " is-active" : ""}`} onClick={() => setTab(t)}>
            {t === "skills" ? "Skills" : "MCP"}
          </button>
        ))}
      </div>
      <label className="st-inline">
        Ámbito
        <select aria-label="Ámbito" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="global">Global</option>
          {projects.map((p) => (
            <option key={p.projectId} value={p.projectId}>
              Proyecto: {p.name}
            </option>
          ))}
          <option value="all">Todos</option>
        </select>
      </label>
      <p className="st-hint">Son los {tab === "mcp" ? "MCP" : "skills"} de tu Claude Code, no los de los robots de Kiji.</p>
      {done && (
        <p className="st-ok" role="status">
          {done}
        </p>
      )}
      {loading && !data && <p className="st-hint">Cargando…</p>}
      {error && <p className="st-hint">{error}</p>}
      {data?.warnings.map((w) => (
        <p key={w.file + w.message} className="st-error">
          {w.file}: {w.message}
        </p>
      ))}
      {data && items.length === 0 && <p className="st-hint">{tab === "mcp" ? "No hay MCP en este ámbito." : "No hay skills en este ámbito."}</p>}
      {items.length > 0 && (
        <ul className="st-list" aria-label={tab === "mcp" ? "MCP instalados" : "Skills instaladas"}>
          {items.map((it) => {
            const managed = it.managedBy;
            const detail = it.kind === "mcp" ? (it.transport === "stdio" ? it.command : it.url) : it.description;
            const origin = it.kind === "mcp" ? it.source : it.path;
            return (
              <li key={`${it.kind}|${it.scope}|${it.projectId}|${it.name}|${origin}`}>
                <strong>{it.name}</strong>
                <span className="st-chip">{it.scope === "local" || it.scope === "project" ? `${SCOPE_LABEL[it.scope]}: ${name(it.projectId) ?? "?"}` : SCOPE_LABEL[it.scope]}</span>
                {it.kind === "mcp" && <span className="st-chip">{it.transport}</span>}
                {it.kind === "skill" && it.isSymlink && <span className="st-chip">enlace</span>}
                <span className="st-hint st-grow">{detail}</span>
                <code className="st-origin">{origin}</code>
                <button
                  type="button"
                  className="st-btn"
                  disabled={!!managed}
                  aria-label={`Desinstalar ${it.name}`}
                  title={managed ? `Lo gestiona ${managed}: desinstala el plugin desde Claude Code.` : undefined}
                  onClick={() => {
                    setFailure(null);
                    setDone(null);
                    setPending(it);
                  }}
                >
                  Desinstalar
                </button>
                {managed && <span className="st-hint st-full">Lo gestiona {managed}: desinstala el plugin desde Claude Code.</span>}
              </li>
            );
          })}
        </ul>
      )}
      {pending && <Confirm item={pending} busy={busy} error={failure} onCancel={() => setPending(null)} onOk={() => void confirm()} />}
    </div>
  );
}
