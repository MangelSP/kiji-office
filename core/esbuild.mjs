// Empaqueta el núcleo en un solo archivo: core/dist/kiji-core.mjs (PLAN-0.3.md, D3).
// schema.sql se embebe vía `define`; el binario nativo de claude y los módulos nativos quedan fuera (D2).
import { build } from 'esbuild';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

await build({
  entryPoints: [here('./src/index.ts')],
  outfile: here('./dist/kiji-core.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: false,
  legalComments: 'none',
  // Paquetes opcionales por plataforma del SDK (binario ~275 MB): el adaptador pasa pathToClaudeCodeExecutable.
  external: ['@anthropic-ai/claude-agent-sdk-*', '@anthropic-ai/claude-code-*', 'fsevents'],
  define: { __KIJI_SCHEMA_SQL__: JSON.stringify(readFileSync(here('./src/db/schema.sql'), 'utf8')) },
  banner: {
    js: "import { createRequire as __kijiCreateRequire } from 'node:module';\nconst require = __kijiCreateRequire(import.meta.url);",
  },
});
console.log(`kiji-core.mjs: ${(statSync(here('./dist/kiji-core.mjs')).size / 1024).toFixed(0)} KiB`);
