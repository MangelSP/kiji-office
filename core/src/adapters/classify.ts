// Clasificador de riesgo único (PLAN-0.1, D4 "Acciones riesgosas").
// Lo usan `claude` (canUseTool) y, más adelante, `api-loop` (run_command).
// Principio: ante la duda, 'ask'. Solo se devuelve 'ok' para lo que con seguridad no ejecuta código arbitrario
// (salvo el código del propio proyecto: `node app.js`, `npm test`, `make`), no escribe fuera de lo esperado,
// no hace red con efectos y no lee credenciales.

import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

export type Risk = 'ok' | 'ask' | 'never';

const SEVERITY: Record<Risk, number> = { ok: 0, ask: 1, never: 2 };
const worst = (a: Risk, b: Risk): Risk => (SEVERITY[a] >= SEVERITY[b] ? a : b);

// ---------------------------------------------------------------------------
// Tokenizador de shell (suficiente para clasificar; no ejecuta nada)
// ---------------------------------------------------------------------------

/** Una palabra del shell con lo que sabemos de cómo se expandirá. */
type Word = {
  t: string; // texto sin comillas
  vars: string[]; // variables expandidas ($X, ${X}) fuera de comillas simples; '!' = indirección ${!x}
  sub: boolean; // contiene $(...) o `...`: su valor se decide en tiempo de ejecución
  glob: boolean; // contiene *, ?, [ o { sin comillas: el shell lo expande a nombres de archivo
};
type Redirect = { op: string; target: Word };
type Segment = { words: Word[]; redirects: Redirect[]; piped: boolean };
type Parsed = {
  segments: Segment[];
  subs: string[]; // contenido de $(...), `...`, <(...), >(...) y de las sustituciones dentro de $((...))
  dubious: boolean; // heredoc, sintaxis sin cerrar, $'...', etc.
};

const word = (t: string): Word => ({ t, vars: [], sub: false, glob: false });

/** Encuentra el `)` que cierra el `(` en `start - 1`; devuelve su índice o -1. */
function matchParen(s: string, start: number): number {
  let depth = 1;
  let quote: string | null = null;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '\\') i++;
    else if (c === "'" || c === '"') quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return -1;
}

const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*/;
const VAR_SPECIAL = /^[0-9@*#?$!-]/;

function parseShell(cmd: string): Parsed {
  const segments: Segment[] = [];
  const subs: string[] = [];
  let dubious = false;

  let words: Word[] = [];
  let redirects: Redirect[] = [];
  let cur = '';
  let hasCur = false;
  let curVars: string[] = [];
  let curSub = false;
  let curGlob = false;
  let pendingRedir: string | null = null;
  let piped = false; // el segmento actual recibe la salida de un `|`

  const pushWord = () => {
    if (!hasCur) return;
    const w: Word = { t: cur, vars: curVars, sub: curSub, glob: curGlob };
    if (pendingRedir !== null) {
      redirects.push({ op: pendingRedir, target: w });
      pendingRedir = null;
    } else {
      words.push(w);
    }
    cur = '';
    hasCur = false;
    curVars = [];
    curSub = false;
    curGlob = false;
  };
  const endSegment = () => {
    pushWord();
    if (pendingRedir !== null) {
      // redirección sin destino: dudoso
      redirects.push({ op: pendingRedir, target: word('') });
      pendingRedir = null;
    }
    if (words.length || redirects.length) {
      segments.push({ words, redirects, piped });
      piped = false;
    }
    words = [];
    redirects = [];
  };
  const addSub = (inner: string) => {
    subs.push(inner);
    cur += '$(…)';
    hasCur = true;
    curSub = true;
  };
  /** Lee `$NAME`, `${NAME…` o `$1`/`$@`… en `i` (cmd[i] === '$'). Copia el texto tal cual y devuelve el índice siguiente. */
  const readVar = (i: number): number => {
    const rest = cmd.slice(i + 1);
    if (rest.startsWith('{')) {
      // solo se consume `${` + nombre: lo que sigue (`:-$(cmd)}`) se sigue analizando normalmente
      const m = /^\{([!#]?)([A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])?/.exec(rest)!;
      if (m[1] === '!') curVars.push('!');
      // `${x@P}` expande el valor como un prompt: ejecuta los $(…) que contenga
      if (rest.startsWith('@P', m[0].length)) dubious = true;
      curVars.push(m[2] ?? '?');
      cur += '$' + m[0];
      hasCur = true;
      return i + 1 + m[0].length;
    }
    const m = VAR_NAME.exec(rest) ?? VAR_SPECIAL.exec(rest);
    if (!m) {
      cur += '$';
      hasCur = true;
      return i + 1;
    }
    curVars.push(m[0]);
    cur += '$' + m[0];
    hasCur = true;
    return i + 1 + m[0].length;
  };

  let i = 0;
  while (i < cmd.length) {
    const c = cmd[i];
    const next = cmd[i + 1];

    if (c === "'") {
      const end = cmd.indexOf("'", i + 1);
      if (end === -1) {
        dubious = true;
        cur += cmd.slice(i + 1);
        hasCur = true;
        break;
      }
      cur += cmd.slice(i + 1, end);
      hasCur = true;
      i = end + 1;
      continue;
    }

    if (c === '"') {
      hasCur = true;
      i++;
      let closed = false;
      while (i < cmd.length) {
        const d = cmd[i];
        if (d === '\\' && i + 1 < cmd.length) {
          cur += cmd[i + 1];
          i += 2;
        } else if (d === '"') {
          closed = true;
          i++;
          break;
        } else if (d === '$' && cmd[i + 1] === '(' && cmd[i + 2] !== '(') {
          const end = matchParen(cmd, i + 2);
          if (end === -1) {
            dubious = true;
            i = cmd.length;
            break;
          }
          addSub(cmd.slice(i + 2, end));
          i = end + 1;
        } else if (d === '$' && cmd[i + 1] !== '(') {
          // `$((…))` entre comillas se recorre carácter a carácter: sus `$(` internos se detectan igual
          i = readVar(i);
        } else if (d === '`') {
          const end = cmd.indexOf('`', i + 1);
          if (end === -1) {
            dubious = true;
            i = cmd.length;
            break;
          }
          addSub(cmd.slice(i + 1, end));
          i = end + 1;
        } else {
          cur += d;
          i++;
        }
      }
      if (!closed) dubious = true;
      continue;
    }

    if (c === '\\') {
      if (next === '\n') {
        i += 2;
        continue;
      }
      if (next !== undefined) {
        cur += next;
        hasCur = true;
      }
      i += 2;
      continue;
    }

    if (c === '`') {
      const end = cmd.indexOf('`', i + 1);
      if (end === -1) {
        dubious = true;
        break;
      }
      addSub(cmd.slice(i + 1, end));
      i = end + 1;
      continue;
    }

    if (c === '$' && (next === "'" || next === '"')) {
      // $'\x2eenv' (ANSI-C) y $"…" (locale): no los decodificamos
      dubious = true;
      i++;
      continue;
    }

    if (c === '$' && next === '(') {
      const end = matchParen(cmd, i + 2);
      if (end === -1) {
        dubious = true;
        break;
      }
      if (cmd[i + 2] === '(' && cmd[end - 1] === ')' && end - 1 > i + 2) {
        // aritmética $(( … )): no es un comando, pero su cuerpo puede tener $(…) o backticks
        const body = cmd.slice(i + 3, end - 1);
        const inner = parseShell(body);
        subs.push(...inner.subs);
        if (inner.dubious) dubious = true;
        cur += '$((…))';
        hasCur = true;
        i = end + 1;
        continue;
      }
      addSub(cmd.slice(i + 2, end));
      i = end + 1;
      continue;
    }

    if (c === '$') {
      i = readVar(i);
      continue;
    }

    if ((c === '<' || c === '>') && next === '(') {
      // sustitución de procesos
      const end = matchParen(cmd, i + 2);
      if (end === -1) {
        dubious = true;
        break;
      }
      addSub(cmd.slice(i + 2, end));
      i = end + 1;
      continue;
    }

    if (c === '#' && !hasCur) {
      while (i < cmd.length && cmd[i] !== '\n') i++;
      continue;
    }

    if (c === ' ' || c === '\t' || c === '\r') {
      pushWord();
      i++;
      continue;
    }

    if (c === '\n' || c === ';') {
      endSegment();
      piped = false;
      i++;
      continue;
    }

    if (c === '(' || c === ')') {
      // subshell o agrupación: el contenido se parsea como comandos del mismo nivel
      endSegment();
      i++;
      continue;
    }

    if (c === '|') {
      endSegment();
      if (next === '|') {
        piped = false;
        i += 2;
      } else {
        piped = true; // `|` y `|&`
        i += next === '&' ? 2 : 1;
      }
      continue;
    }

    if (c === '&') {
      if (next === '>') {
        // &> y &>>
        pushWord();
        const op = cmd[i + 2] === '>' ? '&>>' : '&>';
        pendingRedir = op;
        i += op.length;
        continue;
      }
      endSegment();
      piped = false;
      i += next === '&' ? 2 : 1;
      continue;
    }

    if (c === '>' || c === '<') {
      // un número pegado justo antes es el descriptor (2>, 1>>): se descarta
      if (hasCur && /^\d+$/.test(cur)) {
        cur = '';
        hasCur = false;
      } else {
        pushWord();
      }
      let op = c;
      let j = i + 1;
      if (c === '>' && (cmd[j] === '>' || cmd[j] === '|')) {
        op += cmd[j];
        j++;
      } else if (c === '<' && cmd[j] === '<') {
        op += '<';
        j++;
        if (cmd[j] === '<') {
          op += '<';
          j++;
        } else {
          dubious = true; // heredoc: su cuerpo se parsearía como comandos
        }
      } else if (c === '<' && cmd[j] === '>') {
        op += '>';
        j++;
      }
      if ((c === '>' || c === '<') && cmd[j] === '&') {
        op += '&';
        j++;
      }
      pendingRedir = op;
      i = j;
      continue;
    }

    if (c === '*' || c === '?' || c === '[' || c === '{') curGlob = true;
    cur += c;
    hasCur = true;
    i++;
  }

  endSegment();
  return { segments, subs, dubious };
}

// ---------------------------------------------------------------------------
// Rutas sensibles (se miran en todos los argumentos y destinos de redirección)
// Todas sin distinguir mayúsculas: el sistema de archivos de macOS no las distingue (`.ENV` es `.env`).
// El límite izquierdo incluye `:` para `git show HEAD:.env` y `file:///…/.ssh`.
// ---------------------------------------------------------------------------

/** Ficheros de credenciales del sistema: nunca. */
const NEVER_PATHS: RegExp[] = [
  /(^|[/:])\.ssh(\/|$)/i,
  /(^|[/:])\.aws(\/|$)/i,
  /(^|[/:])\.gnupg(\/|$)/i,
  /(^|[/:])\.netrc$/i,
  /(^|[/:])\.git-credentials$/i,
  /(^|[/:])\.kube\/config$/i,
  /(^|[/:])\.docker\/config\.json$/i,
  /(^|[/:])\.config\/(gcloud|gh)(\/|$)/i,
  /(^|[/:])id_(rsa|dsa|ecdsa|ed25519)$/i,
  /(^|[/:])etc\/(shadow|gshadow|sudoers)(\.d(\/|$)|$)/i,
  /(^|[/:])Library\/Keychains(\/|$)/i,
  /\.keychain(-db)?$/i,
  /(^|[/:])\.claude\/\.credentials\.json$/i,
  /(^|[/:])\.codex\/auth\.json$/i,
  /(^|[/:])\.cargo\/credentials(\.toml)?$/i,
  /(^|[/:])\.config\/github-copilot(\/|$)/i,
  /(^|[/:])\.(pgpass|my\.cnf|vault-token)$/i,
  /(^|[/:])\.terraform\.d\/credentials/i,
];

/** Archivos que se piden siempre: .env*, claves y certificados, .git/, configs con tokens, historiales. */
const ASK_PATHS: RegExp[] = [
  /(^|[/:])\.env/i,
  /\.(pem|key|p12|pfx)$/i,
  /(^|[/:])\.git(\/|$)/i,
  /(^|[/:])\.(npmrc|pypirc|gitconfig)$/i,
  /(^|[/:])\.[\w.-]*_history$/i, // .bash_history, .zsh_history, .python_history…
  /(^|[/:])\.config\/op(\/|$)/i, // 1Password CLI
  /(^|[/:])proc\/[^/]+\/environ$/i,
  /(^|[/:])\.(bashrc|bash_profile|zshrc|zshenv|zprofile|profile)$/i, // suelen llevar `export ANTHROPIC_API_KEY=…`
];

function classifyPathToken(token: string): Risk {
  // `--flag=valor` y `VAR=valor`: se mira también el valor
  const candidates = [token];
  const eq = token.indexOf('=');
  if (eq !== -1) candidates.push(token.slice(eq + 1));
  let result: Risk = 'ok';
  for (const t of candidates) {
    if (NEVER_PATHS.some((re) => re.test(t))) return 'never';
    if (ASK_PATHS.some((re) => re.test(t))) result = 'ask';
  }
  return result;
}

/** Nombres sensibles con los que se prueba si un glob dentro del cwd podría casar (`cat .e*`, `cat *.p?m`). */
const SENSITIVE_SAMPLES = [
  '.env', '.env.local', '.envrc', '.git', '.npmrc', '.pypirc', '.netrc', '.gitconfig', '.git-credentials', '.ssh',
  '.aws', '.gnupg', '.kube', '.docker', '.bash_history', '.zsh_history', 'id_rsa', 'id_ed25519', 'id_ecdsa',
  'server.pem', 'server.key', 'cert.p12', 'environ',
];

/** Un componente de glob (sin `/`) a RegExp, con la regla de bash: `*`/`?` iniciales no casan con un `.` inicial. */
function globComponentRegExp(comp: string): RegExp {
  const body = (s: string): string => {
    let re = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '*') re += '[^/]*';
      else if (c === '?') re += '[^/]';
      else if (c === '[') {
        const close = s.indexOf(']', i + 2);
        if (close === -1) re += '\\[';
        else {
          let cls = s.slice(i + 1, close);
          if (cls.startsWith('!')) cls = '^' + cls.slice(1);
          re += '[' + cls.replace(/\\/g, '\\\\') + ']';
          i = close;
        }
      } else if (c === '{') {
        const close = s.indexOf('}', i + 1);
        const inner = close === -1 ? '' : s.slice(i + 1, close);
        if (close !== -1 && inner.includes(',')) {
          re += '(' + inner.split(',').map(body).join('|') + ')';
          i = close;
        } else if (close !== -1 && inner.includes('..')) {
          re += '[^/]*'; // {a..z}
          i = close;
        } else re += '\\{';
      } else re += c.replace(/[.+^$()|\\\]}]/g, '\\$&');
    }
    return re;
  };
  const lead = comp[0] === '*' || comp[0] === '?' ? '(?!\\.)' : '';
  try {
    return new RegExp(`^${lead}${body(comp)}$`, 'i');
  } catch {
    return /.*/; // glob raro: que case con todo (→ ask)
  }
}

/** Nombres de componentes de NEVER_PATHS con los que se concretan los globs fuera del cwd (`~/.s*\/id_*`). */
const NEVER_SAMPLES = [
  '.ssh', '.aws', '.gnupg', '.netrc', '.git-credentials', '.kube', '.docker', '.config', '.claude', '.codex', '.cargo',
  '.pgpass', '.my.cnf', '.vault-token', '.terraform.d', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'credentials',
  'credentials.toml', 'config', 'config.json', '.credentials.json', 'auth.json', 'gh', 'gcloud', 'github-copilot',
  'authorized_keys', 'Keychains', 'shadow', 'sudoers',
];

/**
 * ¿Algún nombre concreto que podría producir el glob es una ruta de NEVER_PATHS? Cada componente con comodines
 * se sustituye por las muestras con las que casa (o por `x`) y se prueban las combinaciones (como mucho 500).
 */
function globCanHitNever(v: string): boolean {
  let candidates = [''];
  const comps = v.split('/');
  for (let k = 0; k < comps.length; k++) {
    const comp = comps[k];
    let options = [comp];
    if (/[*?[{]/.test(comp)) {
      const re = globComponentRegExp(comp);
      options = NEVER_SAMPLES.filter((s) => re.test(s));
      if (options.length === 0) options = ['x'];
    }
    const next: string[] = [];
    for (const c of candidates) for (const o of options) next.push(k === 0 ? o : `${c}/${o}`);
    if (next.length > 500) return false; // demasiadas combinaciones: se queda en ask
    candidates = next;
  }
  return candidates.some((c) => NEVER_PATHS.some((re) => re.test(c)));
}

/** Palabra con comodines sin comillas: fuera del cwd → ask (never si puede ser una credencial); dentro, si puede casar con un nombre sensible → ask. */
function classifyGlobToken(w: Word): Risk {
  if (!w.glob) return 'ok';
  const values = [w.t];
  const eq = w.t.indexOf('=');
  if (eq !== -1) values.push(w.t.slice(eq + 1));
  for (const v of values) {
    if (!/[*?[{]/.test(v)) continue;
    if (/^(\/|~|\$HOME\b|\$\{HOME\}|\.\.(\/|$))/.test(v) || /(^|\/)\.\.(\/|$)/.test(v)) return globCanHitNever(v) ? 'never' : 'ask';
    for (const comp of v.split('/')) {
      if (!/[*?[{]/.test(comp) || comp === '*' || comp === '**') continue;
      const re = globComponentRegExp(comp);
      if (SENSITIVE_SAMPLES.some((s) => re.test(s))) return 'ask';
    }
  }
  return 'ok';
}

/** Variables cuyo valor suele ser un secreto (`echo $ANTHROPIC_API_KEY`). */
const SECRET_VAR = /KEY|SECRET|TOKEN|PASS|CREDENTIAL|AUTH|URL|DSN|CONN|ROLE/i;

function classifyWordToken(w: Word): Risk {
  let r = classifyPathToken(w.t);
  if (r === 'never') return r;
  r = worst(r, classifyGlobToken(w));
  if (w.vars.some((v) => v === '!' || SECRET_VAR.test(v))) r = worst(r, 'ask');
  return r;
}

// ---------------------------------------------------------------------------
// Clasificación de un comando ya tokenizado
// ---------------------------------------------------------------------------

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Variables de entorno que cambian qué código se ejecuta o qué configuración se lee (PATH, LD_PRELOAD,
 * NODE_OPTIONS, GIT_SSH_COMMAND, HOME → ~/.gitconfig ajeno, CC/MAKEFILES para make…). Asignarlas → ask.
 */
const DANGEROUS_ENV =
  /^(PATH|GIT_|NODE_OPTIONS|NODE_PATH|NODE_REPL_EXTERNAL_MODULE|LD_|DYLD_|BASH_ENV|ENV$|PYTHON|PERL5|PERLLIB|RUBYOPT|RUBYLIB|NPM_CONFIG_|YARN_|PNPM_|BUN_|DENO_|UV_|PIP_|TS_NODE_|HOME$|XDG_CONFIG_HOME|ZDOTDIR|IFS$|PS4$|PROMPT_COMMAND|SHELLOPTS|BASHOPTS|EDITOR$|VISUAL$|PAGER$|MANPAGER|BAT_|LESSOPEN|LESSCLOSE|SHELL$|MAKEFILES|MAKEFLAGS|MFLAGS|CC$|CXX$|CPP$|LD$|AR$|RUSTC|RUSTFLAGS|RUSTDOCFLAGS|CARGO_|GOFLAGS|GOTOOLCHAIN|CGO_|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|SSH_|SUDO_ASKPASS|CURL_HOME|WGETRC|BROWSER$)/i;

const dangerousAssignment = (t: string): boolean => DANGEROUS_ENV.test(t.slice(0, t.indexOf('=')));

const SHELL_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'esac', '!', '{', '}', 'time']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);

/** Comandos de solo lectura / sin efectos fuera del proceso (con sus excepciones tratadas aparte). */
const OK_COMMANDS = new Set([
  'ls', 'll', 'cat', 'bat', 'head', 'tail', 'less', 'more', 'wc', 'pwd', 'echo', 'printf', 'true', 'false',
  'test', '[', '[[', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'fd', 'tree', 'stat', 'file', 'du', 'df', 'diff',
  'cmp', 'uniq', 'cut', 'tr', 'basename', 'dirname', 'realpath', 'readlink', 'which', 'whereis', 'type',
  'date', 'uname', 'whoami', 'id', 'hostname', 'jq', 'yq', 'column', 'nl', 'tac', 'rev', 'seq', 'sleep',
  'md5sum', 'shasum', 'sha256sum', 'cksum', 'xxd', 'hexdump', 'od', 'strings', 'unset', 'tsc', 'vitest',
  'jest', 'eslint', 'prettier', 'pytest', 'ruff', 'mypy', 'rustc', 'tput', 'clear', 'wait', 'return', 'exit', ':',
]);

/** Comandos que muestran el contenido de archivos: con argumentos dinámicos ($VAR, $(…), xargs) → ask. */
const READERS = new Set([
  'cat', 'bat', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'strings', 'xxd', 'hexdump',
  'od', 'nl', 'tac', 'rev', 'cut', 'sort', 'uniq', 'diff', 'jq', 'yq', 'awk', 'gawk', 'mawk', 'nawk', 'sed',
  'column', 'base64', 'cp', 'date',
]);

/** Ejecutores del propio proyecto: un argumento que apunta fuera del cwd (config, plugin, script ajeno) → ask. */
const PROJECT_RUNNERS = new Set(['tsc', 'vitest', 'jest', 'eslint', 'prettier', 'pytest', 'ruff', 'mypy', 'rustc']);

/** Subcomandos permitidos por herramienta (el resto → ask). */
const PKG_OK = new Set(['run', 'run-script', 'test', 't', 'tst', 'start', 'ls', 'list', 'll', 'view', 'info', 'outdated', 'why', 'explain', 'root', 'bin', 'prefix']);
const CARGO_OK = new Set(['build', 'b', 'check', 'c', 'test', 't', 'clippy', 'fmt', 'run', 'r', 'doc', 'bench', 'clean', 'tree', 'metadata', 'version']);
const GO_OK = new Set(['build', 'test', 'vet', 'fmt', 'run', 'list', 'env', 'version']);
const DENO_OK = new Set(['run', 'test', 'fmt', 'lint', 'check', 'task']);
const BUN_OK = new Set(['run', 'test']);
const PIP_OK = new Set(['list', 'show', 'freeze', 'check']);
const DOCKER_OK = new Set(['ps', 'images', 'logs', 'inspect', 'version', 'info']);
const GIT_OK = new Set([
  'status', 'diff', 'log', 'show', 'add', 'commit', 'rev-parse', 'rev-list', 'ls-files', 'ls-tree', 'blame',
  'describe', 'shortlog', 'grep', 'fetch', 'show-ref', 'cat-file', 'diff-tree', 'merge-base', 'for-each-ref',
  'name-rev', 'reflog', 'count-objects', 'ls-remote',
]);

/** Subcomandos de git que muestran contenido: con argumentos dinámicos → ask. */
const GIT_CONTENT_SUBS = new Set(['show', 'grep', 'cat-file', 'diff', 'log']);

const DEPLOY_CLIS = new Set(['vercel', 'fly', 'flyctl', 'gcloud', 'aws', 'kubectl', 'heroku', 'netlify', 'wrangler']);
const NPM_LIKE = new Set(['npm', 'pnpm', 'yarn', 'bun', 'npx', 'pnpx', 'bunx']);
const AWKS = new Set(['awk', 'gawk', 'mawk', 'nawk']);

/** Directorios desde los que un comando con ruta se clasifica por su nombre; cualquier otra ruta → ask. */
const TRUSTED_BIN_DIR = /^(\/usr(\/local)?|\/opt\/homebrew)?\/s?bin$|^(\.\/)?node_modules\/\.bin$/;

/** ¿La ruta (o el valor tras `=`) sale del cwd? Absoluta, `~`, `$VAR…` o con un componente `..`. */
function isOutsidePath(arg: string): boolean {
  const values = [arg];
  const eq = arg.indexOf('=');
  if (eq !== -1) values.push(arg.slice(eq + 1));
  return values.some((v) => /^(\/|~|\$)/.test(v) || /(^|\/)\.\.(\/|$)/.test(v));
}

/** ¿Es un especificador remoto (https:, npm:, jsr:, data:, file:…) y no un archivo local? */
const isRemoteSpecifier = (s: string): boolean => /^[a-z][a-z0-9+.-]+:/i.test(s);

/** ¿Una agrupación de flags cortas (`-sSL`) contiene alguna de estas letras? */
const shortHas = (a: string, letters: string): boolean =>
  /^-[^-]/.test(a) && [...a.slice(1)].some((ch) => letters.includes(ch));

type Ctx = {
  stdin: boolean; // recibe entrada por `|`, `<`, `<<<`
  dynamicArgs: boolean; // xargs añade argumentos que no conocemos
};

/** ¿El destino de una redirección escribe en disco? */
function redirectWrites(r: Redirect): boolean {
  const { op } = r;
  const target = r.target.t;
  if (op === '<' || op === '<<<' || op === '<&') return false;
  if (op === '<<') return true;
  if (op.endsWith('&')) {
    // `>&2`, `2>&1`, `>&-` duplican descriptores; `>&fichero` escribe
    return !(/^\d+$/.test(target) || target === '-');
  }
  return target !== '/dev/null';
}

// --- rm -------------------------------------------------------------------

const FAKE_HOME = '/Users/__home__';

/** ¿`rm -r` sobre esta ruta borraría `/`, el home o un directorio de primer nivel? Normaliza `//`, `/.`, `~/..`, `~usuario`, `/*`. */
function isCatastrophicTarget(arg: string): boolean {
  let p = arg;
  const home = /^(\$HOME|\$\{HOME\}|~[^/]*)(\/.*)?$/.exec(p);
  if (home) p = FAKE_HOME + (home[2] ?? '');
  if (!p.startsWith('/')) return false;
  let n = path.posix.normalize(p).replace(/\/+$/, '') || '/';
  // `/*`, `/.*`, `~/*/*`: un comodín final borra todo el directorio padre
  for (;;) {
    const base = path.posix.basename(n);
    if (n !== '/' && /^[.*?]+$/.test(base) && /[*?]/.test(base)) n = path.posix.dirname(n);
    else break;
  }
  if (n === FAKE_HOME) return true;
  return n.split('/').filter(Boolean).length <= 1;
}

function classifyRm(args: string[]): Risk {
  const opts = args.filter((a) => a.startsWith('-') && a !== '-' && a !== '--');
  const targets = args.filter((a) => !a.startsWith('-') || a === '-');
  const recursive = opts.some((o) => o === '--recursive' || (/^-[a-zA-Z]*[rR]/.test(o) && !o.startsWith('--')));
  const noPreserve = opts.includes('--no-preserve-root');
  if ((recursive || noPreserve) && targets.some(isCatastrophicTarget)) return 'never';
  if (noPreserve) return 'never';
  return 'ask'; // cualquier borrado se confirma (no sabemos si el archivo es propio)
}

// --- git ------------------------------------------------------------------

/** `git -c clave=valor` inofensivos; cualquier otro (core.fsmonitor, core.sshCommand, core.hooksPath…) → ask. */
const gitConfigOk = (kv: string): boolean =>
  /^color\.[^=]*(=.*)?$/i.test(kv) || /^core\.pager=cat$/i.test(kv) || /^commit\.gpgsign=false$/i.test(kv);
const GIT_GLOBAL_OK = new Set(['--version', '--help', '-h', '--no-pager', '-P', '--no-optional-locks', '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--no-replace-objects']);

function classifyGit(args: string[]): Risk {
  let risk: Risk = 'ok';
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    const a = args[i];
    if (a === '-c') {
      if (!gitConfigOk(args[i + 1] ?? '')) risk = 'ask';
      i += 2;
    } else if (a.startsWith('-c')) {
      if (!gitConfigOk(a.slice(2))) risk = 'ask';
      i++;
    } else if (a === '-C') {
      if (isOutsidePath(args[i + 1] ?? '/')) risk = 'ask'; // otro repo: su .git/config podría ejecutar código
      i += 2;
    } else {
      // --git-dir, --work-tree, --exec-path, --config-env, --namespace… → ask
      if (!GIT_GLOBAL_OK.has(a)) risk = 'ask';
      i++;
    }
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (!sub) return worst(risk, 'ok');
  // transportes remotos con helper (`ext::sh -c …`, `fd::`): ejecutan programas
  if (args.some((a) => /^[a-z][a-z0-9+.-]*::/i.test(a))) return 'ask';

  if (sub === 'push') {
    const force = rest.some(
      (a) =>
        a === '--force' ||
        a.startsWith('--force-') ||
        (/^-[a-zA-Z]+$/.test(a) && a.includes('f')) ||
        /^\+\S/.test(a),
    );
    return force ? 'never' : 'ask';
  }

  // opciones que escriben archivos o ejecutan programas desde subcomandos "de lectura"
  const writesOrRuns = rest.some(
    (a) =>
      a === '--output' ||
      a.startsWith('--output=') ||
      a.startsWith('-O') || // git grep -O<pager>, git diff -O<orderfile>
      a.startsWith('--open-files-in-pager') ||
      a.startsWith('--upload-pack') ||
      a.startsWith('--receive-pack') ||
      a === '--exec' ||
      a.startsWith('--exec=') ||
      a === '--ext-diff' ||
      a === '--no-index', // git diff --no-index lee archivos fuera del repo
  );
  if (writesOrRuns) return 'ask';

  if (sub === 'branch') {
    // `git branch nombre` crea una rama y `-d/-D/-m` borran o renombran: se confirman
    const listing = ['-a', '-r', '-v', '-vv', '--list', '-l', '--show-current', '--all', '--remotes'];
    return worst(risk, rest.every((a) => listing.includes(a)) ? 'ok' : 'ask');
  }
  if (sub === 'remote') {
    const listing = rest.every((a) => a === '-v' || a === '--verbose');
    const query = (rest[0] === 'show' || rest[0] === 'get-url') && rest.slice(1).every((a) => !a.startsWith('-') || ['-n', '--all', '--push'].includes(a));
    return worst(risk, listing || query ? 'ok' : 'ask');
  }
  if (sub === 'stash') return worst(risk, rest[0] === 'list' || rest[0] === 'show' ? 'ok' : 'ask');
  if (sub === 'tag') return worst(risk, rest.length === 0 || rest.every((a) => a === '-l' || a === '--list') ? 'ok' : 'ask');
  if (sub === 'config') return worst(risk, rest.includes('--get') || rest.includes('--list') || rest.includes('-l') ? 'ok' : 'ask');
  if (GIT_OK.has(sub)) return risk;
  // reset, clean, checkout, restore, switch, rebase, merge, cherry-pick, revert, rm, mv, apply, pull, worktree…
  return 'ask';
}

// --- red ------------------------------------------------------------------

/** URL aceptable para una petición de lectura: http(s) o sin esquema (curl asume http). */
const isHttpUrl = (s: string): boolean => /^https?:\/\//i.test(s) || !/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s); // `localhost:3000` sí, `file:/etc` no

const CURL_SHORT_NOARG = 'sSLIivfk';
const CURL_SHORT_ARG = 'HAm';
const CURL_LONG_NOARG = new Set(['--silent', '--show-error', '--location', '--head', '--include', '--fail', '--insecure', '--compressed', '--verbose']);
const CURL_LONG_ARG = new Set(['--header', '--user-agent', '--max-time', '--retry']);

/** curl: lista blanca de flags inofensivas (expandiendo `-sSL`); cualquier otra (-X, -d, -o, -O, -u, -K, -c, -D, --trace…) → ask. */
function classifyCurl(args: string[]): Risk {
  const valueOk = (flag: string, v: string | undefined): boolean =>
    v !== undefined && !((flag === 'H' || flag === '--header') && v.startsWith('@')); // -H @archivo lee un archivo
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      if (!args.slice(i + 1).every(isHttpUrl)) return 'ask';
      break;
    }
    if (a.startsWith('--')) {
      if (CURL_LONG_NOARG.has(a)) continue;
      if (CURL_LONG_ARG.has(a)) {
        if (!valueOk(a, args[++i])) return 'ask';
        continue;
      }
      return 'ask';
    }
    if (a.startsWith('-') && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const ch = a[j];
        if (CURL_SHORT_NOARG.includes(ch)) continue;
        if (CURL_SHORT_ARG.includes(ch)) {
          const v = j + 1 < a.length ? a.slice(j + 1) : args[++i];
          if (!valueOk(ch, v)) return 'ask';
          break;
        }
        return 'ask';
      }
      continue;
    }
    if (!isHttpUrl(a)) return 'ask'; // file://, ftp://, dict://, gopher://…
  }
  return 'ok';
}

/** wget: solo `-q -O -` (a stdout) es lectura; lo demás descarga a disco o cambia configuración → ask. */
function classifyWget(args: string[]): Risk {
  let toStdout = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-q' || a === '--quiet') continue;
    if (a === '--output-document=-') {
      toStdout = true;
      continue;
    }
    if (a === '--output-document') {
      if (args[++i] !== '-') return 'ask';
      toStdout = true;
      continue;
    }
    if (/^-q*O/.test(a)) {
      const v = a.slice(a.indexOf('O') + 1) || args[++i];
      if (v !== '-') return 'ask';
      toStdout = true;
      continue;
    }
    if (a.startsWith('-')) return 'ask';
    if (!/^https?:\/\//i.test(a)) return 'ask';
  }
  return toStdout ? 'ok' : 'ask';
}

// --- intérpretes ------------------------------------------------------------

const VERSION_FLAGS = new Set(['-v', '-V', '--version', '-h', '--help']);
const NODE_SAFE_FLAG =
  /^--(enable-source-maps|no-warnings|trace-warnings|trace-uncaught|test|watch|no-deprecation|experimental-vm-modules|experimental-strip-types|experimental-transform-types|expose-gc|no-cache|(max-old-space-size|stack-trace-limit)=\d+)$/;

/**
 * Ejecuta un script local del proyecto (`node app.js`, `python x.py`). Pide permiso si hay código en línea o por
 * stdin (-e, -p, -c, `-`, sin script, entrada por `|`/`<`/`<<<`), si precarga módulos (-r, --require, --import,
 * --loader), o si el script es remoto, está fuera del cwd o en node_modules.
 */
function classifyScript(args: string[], ctx: Ctx, flagOk: (a: string) => boolean): Risk {
  if (args.length > 0 && args.every((a) => VERSION_FLAGS.has(a))) return 'ok';
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '-') return 'ask';
    if (a === '--') {
      i++;
      break;
    }
    if (!a.startsWith('-')) break;
    if (!flagOk(a)) return 'ask';
  }
  const script = args[i];
  if (script === undefined || ctx.dynamicArgs) return 'ask'; // REPL o código por stdin
  if (ctx.stdin) return 'ask';
  if (isRemoteSpecifier(script) || isOutsidePath(script) || /(^|\/)node_modules\//.test(script)) return 'ask';
  return 'ok';
}

function classifyNode(args: string[], ctx: Ctx): Risk {
  return classifyScript(args, ctx, (a) => NODE_SAFE_FLAG.test(a));
}

/** `python -m <módulo>`: solo ejecutores de tests y pip (que se clasifica como pip). */
function classifyPython(args: string[], ctx: Ctx, depth: number): Risk {
  if (args.length > 0 && args.every((a) => VERSION_FLAGS.has(a))) return 'ok';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-' || a === '--' || !a.startsWith('-')) break;
    if (a.startsWith('--')) return 'ask';
    for (let j = 1; j < a.length; j++) {
      const ch = a[j];
      if ('uBOIsESqbdv'.includes(ch)) continue;
      if (ch === 'm') {
        const mod = a.slice(j + 1) || args[i + 1];
        const rest = args.slice(a.slice(j + 1) ? i + 1 : i + 2);
        if (mod === 'pip') return classifyWords([word('pip'), ...rest.map(word)], depth + 1, ctx);
        if (mod === 'pytest' || mod === 'unittest' || mod === 'mypy') return rest.some(isOutsidePath) ? 'ask' : 'ok';
        return 'ask'; // http.server, venv, ensurepip, cualquier otro módulo
      }
      return 'ask'; // -c, -W, -X, -i…
    }
  }
  return classifyScript(args, ctx, (a) => /^-[uBOIsESqbdv]+$/.test(a));
}

function classifyDeno(args: string[], ctx: Ctx): Risk {
  const subIdx = args.findIndex((a) => !a.startsWith('-'));
  const sub = args[subIdx];
  if (!sub || !DENO_OK.has(sub)) return 'ask';
  if (sub !== 'run' && sub !== 'test') return 'ok';
  const bad = args.some(
    (a) =>
      a === '-' ||
      shortHas(a, 'A') ||
      /^--(allow-all|allow-run|allow-ffi|v8-flags|inspect|inspect-brk|inspect-wait|env-file|env|unsafely-ignore-certificate-errors)(=|$)/.test(a) ||
      /(^|=)(https?|npm|jsr|data):/i.test(a),
  );
  if (bad) return 'ask';
  if (sub === 'test') return args.some(isOutsidePath) ? 'ask' : 'ok';
  const script = args.slice(subIdx + 1).find((a) => !a.startsWith('-'));
  if (!script || ctx.stdin || ctx.dynamicArgs || isOutsidePath(script)) return 'ask';
  return 'ok';
}

function classifyBun(args: string[], ctx: Ctx): Risk {
  // -e/--eval, -p/--print, -r/--preload, -c/--config, -i (auto-instalar) → ask
  const bad = args.some(
    (a) => shortHas(a, 'eprci') || /^--(eval|print|preload|require|import|loader|config|env-file|define|install)(=|$)/.test(a),
  );
  if (bad) return 'ask';
  const subIdx = args.findIndex((a) => !a.startsWith('-'));
  const sub = args[subIdx];
  if (!sub || !BUN_OK.has(sub)) return 'ask';
  if (args.some(isOutsidePath)) return 'ask';
  if (sub === 'test') return 'ok';
  const script = args.slice(subIdx + 1).find((a) => !a.startsWith('-'));
  if (!script || script === '-' || ctx.stdin || ctx.dynamicArgs || isRemoteSpecifier(script)) return 'ask';
  return 'ok';
}

/** awk: el programa no puede ejecutar comandos (`system`, `|`), escribir (`>`), leer el entorno ni otros archivos. */
function classifyAwk(args: string[]): Risk {
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      i++;
      break;
    }
    if (!a.startsWith('-') || a === '-') break;
    if (a === '-F' || a === '-v') {
      i++;
      continue;
    }
    if (/^-[Fv]./.test(a)) continue;
    return 'ask'; // -f programa.awk, -e, -i, -l, -E…: código que no vemos
  }
  const program = args[i];
  if (program === undefined) return 'ask';
  if (/system\s*\(|[>|]|ENVIRON|PROCINFO|getline|@(load|include|namespace)/.test(program)) return 'ask';
  return 'ok';
}

/** sed: `w`/`W` (escribir), `e` (ejecutar), `r`/`R` (leer otro archivo) en el script → ask; `-i`, `-f` → ask. */
function classifySed(args: string[]): Risk {
  const scripts: string[] = [];
  let explicit = false;
  let firstPositional: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--in-place' || a.startsWith('--in-place=') || (/^-[A-Za-z]*i/.test(a) && !a.startsWith('--'))) return 'ask';
    if (a === '-f' || a.startsWith('--file') || /^-[A-Za-z]*f/.test(a)) return 'ask';
    if (a === '-e' || a === '--expression') {
      scripts.push(args[++i] ?? '');
      explicit = true;
    } else if (a.startsWith('--expression=')) {
      scripts.push(a.slice('--expression='.length));
      explicit = true;
    } else if (/^-[nErsuz]*e./.test(a)) {
      scripts.push(a.slice(a.indexOf('e') + 1));
      explicit = true;
    } else if (!a.startsWith('-') && firstPositional === undefined) firstPositional = a;
  }
  if (!explicit && firstPositional !== undefined) scripts.push(firstPositional);
  const danger = /(^|[;{}\n!\/0-9$])\s*[wWerR]([\s;}]|$|[^a-zA-Z])/;
  return scripts.some((s) => danger.test(s)) ? 'ask' : 'ok';
}

function classifyMake(args: string[]): Risk {
  for (const a of args) {
    if (a.includes('=') && !a.startsWith('-')) return 'ask'; // `make CC="rm -rf x"`: sobrescribe variables de las recetas
    if (/^--(file|makefile|directory|eval|include-dir)(=|$)/.test(a)) return 'ask';
    if (shortHas(a, 'fCEI') && !a.startsWith('--')) return 'ask'; // -f otro Makefile, -C otro dir, -E/--eval código
    if (isOutsidePath(a)) return 'ask';
  }
  return 'ok';
}

function classifyCmake(args: string[]): Risk {
  for (const a of args) {
    if (/^-[PEC]/.test(a) || a.startsWith('--toolchain')) return 'ask'; // -P script, -E órdenes, -C caché inicial
    if (/^-D.*(INCLUDE|LAUNCHER|TOOLCHAIN|COMPILER|MODULE_PATH|PREFIX_PATH)/i.test(a)) return 'ask';
    if (/^(\/|~|\$)/.test(a.replace(/^-[SB]/, ''))) return 'ask';
  }
  return 'ok';
}

function classifyNpmLike(name: string, args: string[], ctx: Ctx): Risk {
  if (name === 'npx' || name === 'pnpx' || name === 'bunx') return 'ask'; // descarga y ejecuta código
  if (name === 'bun') return classifyBun(args, ctx);
  const dd = args.indexOf('--');
  const own = dd === -1 ? args : args.slice(0, dd);
  // config por línea de comandos que cambia qué se ejecuta: --node-options, --script-shell, --prefix, -C dir…
  const badFlag = own.some((a) =>
    /^--(node-options|script-shell|shell|userconfig|globalconfig|prefix|dir|cwd|cache|registry|init-module|onload-script|git|editor|browser|viewer|npm-path)(=|$)/i.test(a) ||
    /^-C/.test(a),
  );
  if (badFlag || args.some(isOutsidePath)) return 'ask';
  if (args.length > 0 && args.every((a) => VERSION_FLAGS.has(a))) return 'ok';
  // el valor de `--workspace core` / `--filter x` no es el subcomando
  const valueFlags = name === 'pnpm' ? ['--filter', '-F'] : name === 'npm' ? ['--workspace', '-w'] : [];
  let sub: string | undefined;
  for (let k = 0; k < own.length; k++) {
    if (valueFlags.includes(own[k])) k++;
    else if (!own[k].startsWith('-')) {
      sub = own[k];
      break;
    }
  }
  if (!sub) return 'ask'; // `yarn`/`npm` a secas instala o no sabemos
  if (sub === 'publish' || sub === 'login' || sub === 'adduser') return 'ask';
  return PKG_OK.has(sub) ? 'ok' : 'ask'; // i/install/add/ci/update/exec/dlx → ask
}

// --- despacho ---------------------------------------------------------------

/** Clasifica una lista de palabras (con posibles asignaciones iniciales). `depth` evita recursión infinita. */
function classifyWords(input: Word[], depth: number, ctx: Ctx): Risk {
  if (depth > 6) return 'ask';
  const words = input.slice();
  let risk: Risk = 'ok';

  // asignaciones previas y palabras clave del shell
  for (;;) {
    while (words.length && ASSIGNMENT.test(words[0].t)) {
      if (dangerousAssignment(words[0].t)) risk = 'ask'; // PATH=…, NODE_OPTIONS=…, GIT_SSH_COMMAND=…
      words.shift();
    }
    if (words.length && SHELL_KEYWORDS.has(words[0].t)) {
      words.shift();
      continue;
    }
    break;
  }
  if (words.length === 0) return risk;
  return worst(risk, classifyNamed(words, depth, ctx));
}

function classifyNamed(words: Word[], depth: number, ctx: Ctx): Risk {
  const first = words[0].t;
  // el nombre del comando no se puede resolver
  if (first.includes('$') || words[0].sub) return 'ask';
  // `/tmp/evil/ls` ejecuta ese binario, no `ls`: solo se confía en los directorios del sistema y node_modules/.bin
  if (first.includes('/') && !TRUSTED_BIN_DIR.test(path.posix.dirname(first))) return 'ask';

  const name = first.includes('/') ? path.posix.basename(first) : first;
  const argw = words.slice(1);
  const args = argw.map((w) => w.t);

  // estructuras de control: la cabecera no ejecuta nada por sí misma
  if (name === 'for' || name === 'case' || name === 'select') return 'ok';

  // lectores con argumentos que solo se conocen al ejecutar (`cat $(printf ~/.%s/id_rsa ssh)`, `… | xargs cat`)
  if (READERS.has(name) && (ctx.dynamicArgs || argw.some((w) => w.sub || w.vars.some((v) => v !== 'HOME' && v !== 'PWD')))) {
    return 'ask';
  }

  switch (name) {
    case 'sudo':
    case 'doas': {
      let i = 0;
      while (i < args.length && args[i].startsWith('-')) i += ['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U'].includes(args[i]) ? 2 : 1;
      return worst('ask', classifyWords(argw.slice(i), depth + 1, ctx));
    }
    case 'su':
    case 'eval':
    case 'source':
    case '.':
    case 'printenv':
      return 'ask';
    case 'export':
      // `export` / `export -p` vuelcan el entorno; `export PATH=…` cambia qué se ejecuta después
      return args.length > 0 && args.every((a) => ASSIGNMENT.test(a) && !dangerousAssignment(a)) ? 'ok' : 'ask';
    case 'env': {
      let i = 0;
      let risk: Risk = 'ok';
      while (i < args.length && (args[i].startsWith('-') || ASSIGNMENT.test(args[i]))) {
        if (ASSIGNMENT.test(args[i]) && dangerousAssignment(args[i])) risk = 'ask';
        i += args[i] === '-u' ? 2 : 1;
      }
      if (i >= args.length) return 'ask'; // `env` a secas vuelca el entorno
      return worst(risk, classifyWords(argw.slice(i), depth + 1, ctx));
    }
    case 'command':
    case 'builtin':
    case 'nohup':
    case 'exec':
    case 'stdbuf': {
      let i = 0;
      while (i < args.length && args[i].startsWith('-')) i++;
      return classifyWords(argw.slice(i), depth + 1, ctx);
    }
    case 'nice':
    case 'timeout': {
      let i = 0;
      while (i < args.length && args[i].startsWith('-')) i += args[i] === '-n' ? 2 : 1;
      if (name === 'timeout') i++; // duración
      return classifyWords(argw.slice(i), depth + 1, ctx);
    }
    case 'xargs': {
      let i = 0;
      while (i < args.length && args[i].startsWith('-')) {
        i += ['-I', '-n', '-P', '-d', '-L', '-s', '-E', '-a'].includes(args[i]) ? 2 : 1;
      }
      if (i >= args.length) return 'ok'; // xargs a secas ejecuta echo
      return classifyWords(argw.slice(i), depth + 1, { stdin: false, dynamicArgs: true });
    }
  }

  if (SHELLS.has(name)) {
    const ci = args.findIndex((a) => /^-[a-zA-Z]*c$/.test(a));
    if (ci !== -1 && args[ci + 1] !== undefined) return classifyCommandInner(args[ci + 1], depth + 1);
    return 'ask'; // ejecutar un script, un shell interactivo o código por stdin
  }

  if (name === 'rm') return classifyRm(args);
  if (name === 'git') {
    // `git grep . -- "$(printf .en%s v)"`, `git show HEAD:$f`: la ruta se decide al ejecutar
    const dyn = argw.some((w) => w.sub || w.vars.some((v) => v !== 'HOME' && v !== 'PWD'));
    if ((dyn || ctx.dynamicArgs) && args.some((a) => GIT_CONTENT_SUBS.has(a))) return 'ask';
    return classifyGit(args);
  }
  if (name === 'cd') {
    // tras `cd /fuera`, `npm test`/`make`/`node app.js` ejecutarían código ajeno al proyecto
    const target = args.find((a) => a !== '-P' && a !== '-L' && a !== '--');
    return target === undefined || target === '-' || isOutsidePath(target) ? 'ask' : 'ok';
  }

  if (name === 'find') {
    const bad = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls']);
    return args.some((a) => bad.has(a)) ? 'ask' : 'ok';
  }
  if (name === 'fd') {
    return args.some((a) => /^--exec(-batch)?(=|$)/.test(a) || (shortHas(a, 'xX') && !a.startsWith('--'))) ? 'ask' : 'ok';
  }
  if (name === 'rg') return args.some((a) => a === '--pre' || a.startsWith('--pre=')) ? 'ask' : 'ok';
  if (AWKS.has(name)) return classifyAwk(args);
  if (name === 'sed') return classifySed(args);
  if (name === 'sort') {
    return args.some((a) => a === '-o' || /^-[a-zA-Z]*o/.test(a) || a.startsWith('--output') || a.startsWith('--compress-program')) ? 'ask' : 'ok';
  }
  if (name === 'less' || name === 'more') {
    // `less '+!cmd'` ejecuta; `-o`/`-O` escriben un log
    return args.some((a) => a.startsWith('+') || (shortHas(a, 'oO') && !a.startsWith('--')) || /^--log-file|^--LOG-FILE/i.test(a)) ? 'ask' : 'ok';
  }
  if (name === 'bat') return args.some((a) => a.startsWith('--pager')) ? 'ask' : 'ok';
  if (name === 'tree') return args.some((a) => a.startsWith('--output') || (shortHas(a, 'oR') && !a.startsWith('--'))) ? 'ask' : 'ok';
  if (name === 'printf') return args.some((a) => a === '-v' || a.startsWith('-v')) ? 'ask' : 'ok'; // printf -v PATH …
  if (name === 'uniq' || name === 'xxd') {
    // `uniq entrada salida` y `xxd entrada salida` escriben el segundo archivo
    const positional = args.filter((a, i) => !a.startsWith('-') && !(name === 'xxd' && /^-[cglson]$/.test(args[i - 1] ?? '')));
    return positional.length >= 2 ? 'ask' : 'ok';
  }
  if (name === 'yq' && args.some((a) => a === '--inplace' || a.startsWith('--inplace=') || a.startsWith('--split-exp') || (shortHas(a, 'is') && !a.startsWith('--')))) {
    return 'ask'; // yq -i / eval -i escribe el archivo; -s/--split-exp escribe un archivo por documento
  }
  if (name === 'jq' || name === 'yq') {
    // `jq -n env`, `$ENV.X`, yq `strenv()`/`load()`: leen el entorno u otros archivos
    return args.some((a) => /\benv\b|\$ENV|\$__loc__|strenv|\bload(_str)?\s*\(/.test(a)) ? 'ask' : 'ok';
  }
  if (name === 'file') return args.some((a) => shortHas(a, 'C')) ? 'ask' : 'ok';
  if (name === 'make') return classifyMake(args);
  if (name === 'cmake') return classifyCmake(args);
  if (PROJECT_RUNNERS.has(name)) return args.some(isOutsidePath) ? 'ask' : 'ok';

  if (name === 'tee') return 'ask';
  if (name === 'curl') return classifyCurl(args);
  if (name === 'wget') return classifyWget(args);

  if (DEPLOY_CLIS.has(name)) return 'ask';

  if (name === 'docker' || name === 'podman') {
    const sub = args.find((a) => !a.startsWith('-'));
    return sub && DOCKER_OK.has(sub) ? 'ok' : 'ask'; // incluye `docker push`
  }

  if (name === 'security') return args.some((a) => /^(find-|dump-|export|delete-)/.test(a)) ? 'never' : 'ask';
  if (name === 'gpg' || name === 'gpg2') return args.some((a) => a.startsWith('--export-secret')) ? 'never' : 'ask';

  if (NPM_LIKE.has(name)) return classifyNpmLike(name, args, ctx);

  if (name === 'node' || name === 'nodejs') return classifyNode(args, ctx);
  if (name === 'tsx') return classifyNode(args[0] === 'watch' ? args.slice(1) : args, ctx);
  if (/^python(\d+(\.\d+)?)?$/.test(name)) return classifyPython(args, ctx, depth);
  if (name === 'perl') return args.length > 0 && args.every((a) => VERSION_FLAGS.has(a)) ? 'ok' : 'ask'; // perl -e, -i, script.pl
  if (name === 'deno') return classifyDeno(args, ctx);

  if (name === 'cargo') {
    const sub = args.find((a) => !a.startsWith('-') && !a.startsWith('+'));
    if (args.some((a) => /^--config(=|$)|^-Z/.test(a) || isOutsidePath(a))) return 'ask';
    if (args.length > 0 && args.every((a) => VERSION_FLAGS.has(a))) return 'ok';
    return sub && CARGO_OK.has(sub) ? 'ok' : 'ask'; // add/install/publish → ask
  }
  if (name === 'go') {
    const subIdx = args.findIndex((a) => !a.startsWith('-'));
    const sub = args[subIdx];
    if (!sub || !GO_OK.has(sub)) return 'ask';
    if (args.some((a) => /^--?(toolexec|exec|overlay|modfile|pgo)(=|$)/.test(a) || isOutsidePath(a))) return 'ask';
    if (sub === 'env' && args.some((a) => a === '-w' || a === '-u')) return 'ask'; // cambia la config persistente de go
    if (sub === 'run' || sub === 'test') {
      // `go run github.com/x/y@latest` descarga y ejecuta código ajeno
      const pkgs = args.slice(subIdx + 1).filter((a) => !a.startsWith('-'));
      if (pkgs.some((p) => p.includes('@') || /^[a-z0-9-]+(\.[a-z0-9-]+)+\//i.test(p))) return 'ask';
    }
    return 'ok';
  }
  if (name === 'uv') {
    const subIdx = args.findIndex((a) => !a.startsWith('-'));
    if (subIdx !== 0 || args[0] !== 'run') return 'ask';
    let i = 1;
    const safe = new Set(['--frozen', '--locked', '--no-sync', '--offline', '-q', '--quiet']);
    for (; i < args.length && args[i].startsWith('-'); i++) if (!safe.has(args[i])) return 'ask'; // --with instala, --script…
    const rest = argw.slice(i);
    if (rest.length === 0) return 'ask';
    if (/\.py$/i.test(rest[0].t)) return classifyWords([word('python'), ...rest], depth + 1, ctx);
    return classifyWords(rest, depth + 1, ctx);
  }
  if (name === 'pip' || name === 'pip3') {
    const sub = args.find((a) => !a.startsWith('-'));
    return sub && PIP_OK.has(sub) ? 'ok' : 'ask';
  }

  if (OK_COMMANDS.has(name)) return 'ok';

  // Escritores (rm ya tratado), brew, apt, ssh, kill, mv, cp, touch, mkdir, chmod, dd, open, ruby, ts-node,
  // declare/typeset/alias/set… y todo lo desconocido.
  return 'ask';
}

function classifyCommandInner(cmd: string, depth: number): Risk {
  if (depth > 6) return 'ask';
  const parsed = parseShell(cmd);
  let result: Risk = parsed.dubious ? 'ask' : 'ok';

  for (const inner of parsed.subs) result = worst(result, classifyCommandInner(inner, depth + 1));

  for (const seg of parsed.segments) {
    for (const w of seg.words) result = worst(result, classifyWordToken(w));
    for (const r of seg.redirects) {
      result = worst(result, classifyWordToken(r.target));
      if (r.target.t === '' || redirectWrites(r)) result = worst(result, 'ask');
      if (r.target.sub || r.target.vars.some((v) => v !== 'HOME' && v !== 'PWD')) result = worst(result, 'ask');
    }
    const stdin = seg.piped || seg.redirects.some((r) => r.op.startsWith('<'));
    result = worst(result, classifyWords(seg.words, depth, { stdin, dynamicArgs: false }));
    if (result === 'never') return 'never';
  }
  return result;
}

/**
 * Clasifica un comando de shell (Bash) en 'ok' (se ejecuta), 'ask' (pide clic) o 'never' (deny fijo).
 * Entiende `&&`, `||`, `;`, `|`, `&`, saltos de línea, subshells `( )`, `$( )`, backticks, `$(( ))`, `sh -c`,
 * redirecciones que escriben, asignaciones de entorno peligrosas, intérpretes con código en línea, globs y
 * variables, y envoltorios (`sudo`, `env`, `xargs`, `timeout`…).
 */
export function classifyCommand(cmd: string): Risk {
  if (typeof cmd !== 'string') return 'ask';
  return classifyCommandInner(cmd, 0);
}

/** Clasifica una ruta de archivo (para Read/Glob/Grep/Edit): sensible → 'ask' o 'never'. */
export function classifyPath(p: string): Risk {
  return classifyPathToken(p);
}

// ---------------------------------------------------------------------------
// Propiedad de archivos
// ---------------------------------------------------------------------------

function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++; // `**/` también casa con cero directorios
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/**
 * Resuelve symlinks: `realpath` del ancestro existente más profundo + el resto de la ruta. Devuelve null si un
 * componente existe pero no se puede resolver (symlink colgante: escribir en él crearía su destino, quizá fuera).
 */
function resolveReal(abs: string): string | null {
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    let exists = true;
    try {
      lstatSync(cur);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null;
      exists = false;
    }
    if (exists) {
      try {
        return path.join(realpathSync(cur), ...tail);
      } catch {
        return null;
      }
    }
    const parent = path.dirname(cur);
    if (parent === cur) return path.join(cur, ...tail);
    tail.unshift(path.basename(cur));
    cur = parent;
  }
}

/** Ruta relativa a `root` si queda estrictamente dentro (o es `root` cuando `allowRoot`); si no, null. */
function relInside(root: string, abs: string, allowRoot: boolean): string | null {
  const rel = path.relative(root, abs);
  if (rel === '') return allowRoot ? '' : null;
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return null;
  return rel;
}

/** Ruta real relativa al cwd real, o null si `p` sale del cwd (por `..`, por ser absoluta fuera o por un symlink). */
function realRelative(p: string, cwd: string, allowRoot: boolean): string | null {
  if (typeof p !== 'string' || p === '' || p.includes('\0') || p.startsWith('~')) return null;
  const root = path.resolve(cwd);
  const abs = path.resolve(root, p);
  if (relInside(root, abs, allowRoot) === null) return null;
  const realRoot = resolveReal(root);
  const realAbs = resolveReal(abs);
  if (realRoot === null || realAbs === null) return null;
  return relInside(realRoot, realAbs, allowRoot);
}

/**
 * ¿Puede el agente escribir en `p`? `p` se normaliza contra `cwd` y se resuelven los symlinks (del ancestro
 * existente más profundo): si sale del cwd real se rechaza. Cada entrada de `allowed` (relativa al cwd o absoluta
 * dentro de él) puede ser un archivo, un directorio (permite todo su contenido) o un glob con `*`, `**`, `?`; se
 * compara con la ruta real, así un symlink interno hacia un archivo no permitido tampoco cuela.
 */
export function isPathAllowed(p: string, allowed: string[], cwd: string): boolean {
  const rel = realRelative(p, cwd, false);
  if (rel === null) return false;
  const relPosix = rel.split(path.sep).join('/');
  const root = path.resolve(cwd);

  return allowed.some((entry) => {
    if (typeof entry !== 'string' || entry === '' || entry.includes('\0')) return false;
    const entryRel = relInside(root, path.resolve(root, entry), false);
    if (entryRel === null) return false;
    const e = entryRel.split(path.sep).join('/');
    if (/[*?]/.test(entry)) return globToRegExp(e).test(relPosix);
    return relPosix === e || relPosix.startsWith(e + '/');
  });
}

/** ¿`p` (normalizada contra `cwd` y con symlinks resueltos) queda dentro del cwd? Sin mirar la lista de propiedad. */
export function isInsideCwd(p: string, cwd: string): boolean {
  return realRelative(p, cwd, true) !== null;
}
