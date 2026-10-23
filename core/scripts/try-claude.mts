// Prueba manual (cuesta centavos): `npm run build:core && node core/scripts/try-claude.mts`
// Crea un repo temporal, pide a Claude crear hola.txt y luego `rm hola.txt`; el `rm` debe llegar como
// permission_request y aquí se DENIEGA automáticamente. Usa la autenticación que ya tenga el usuario.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ClaudeAdapter } from '../dist/adapters/claude.js';

const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), 'kiji-try-')));
execFileSync('git', ['init', '-q'], { cwd });

const adapter = new ClaudeAdapter();
const started = Date.now();
const kinds: string[] = [];

for await (const ev of adapter.start({
  runId: 'try-1',
  cwd,
  model: 'haiku',
  budgetUsd: 0.05,
  systemPrompt: 'Eres un programador. Haz exactamente lo que se pide, sin explicaciones largas.',
  prompt: 'crea el archivo hola.txt con la palabra hola y luego ejecuta `rm hola.txt`',
  allowedPaths: ['hola.txt'],
})) {
  kinds.push(ev.type);
  const brief = JSON.stringify(ev, (_k, v) => (typeof v === 'string' && v.length > 120 ? v.slice(0, 120) + '…' : v));
  console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${brief}`);
  if (ev.type === 'permission_request') {
    console.log(`   -> DENY automático (${ev.tool})`);
    adapter.answerPermission(ev.id, false, 'Prueba automática: no se permite borrar.');
  }
}

console.log('\nsecuencia:', kinds.join(' -> '));
console.log('hola.txt existe tras el run:', existsSync(path.join(cwd, 'hola.txt')), `(${cwd})`);
