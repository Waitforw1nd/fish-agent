// Negative control: restore the pre-review behavior only for QR generation.
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';

registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('/src/bili/buvid.js')) {
    let source = readFileSync(new URL(url), 'utf8');
    source = source.replace("  if (generation !== jar.generation) throw new BridgeError('Session changed', { kind: 'CANCELLED', code: 409, retcode: 1409 });\n", '');
    return { format: 'module', source, shortCircuit: true };
  }
  if (url.endsWith('/src/bridge.js')) {
    let source = readFileSync(new URL(url), 'utf8');
    source = source.replace("    if (revision !== this.qrRequestRevision || generation !== this.jar.generation) {\n      throw new BridgeError('QR login changed', { kind: 'CANCELLED', code: 409, retcode: 1409 });\n    }\n", '');
    return { format: 'module', source, shortCircuit: true };
  }
  if (!url.endsWith('/src/bili/auth.js')) return nextLoad(url, context);
  let source = readFileSync(new URL(url), 'utf8');
  source = source.replace('const revision = ++this.qrRevision;', 'const revision = this.qrRevision;');
  return { format: 'module', source, shortCircuit: true };
} });
