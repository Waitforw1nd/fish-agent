// Negative control: restore only the pre-review ensureSession behavior in memory.
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';

registerHooks({ load(url, context, nextLoad) {
  if (!url.endsWith('/src/bili/auth.js')) return nextLoad(url, context);
  let source = readFileSync(new URL(url), 'utf8').replace(/\r\n/g, '\n');
  const fixed = `    const generation = this.jar.generation;
    try {
      const info = await this.getSelfInfo({ refresh: true });
      this.assertGeneration(generation);`;
  const old = `    try {
      const info = await this.getSelfInfo({ refresh: true });`;
  const guard = `      // Cancellation is not a transient network failure. In particular, an
      // old validation must not report or alter the state of a newer session.
      this.assertGeneration(generation);
      if (error?.kind === 'CANCELLED') throw error;
`;
  if (!source.includes(fixed) || !source.includes(guard)) throw new Error('Negative control did not match the fix');
  source = source.replace(fixed, old).replace(guard, '');
  return { format: 'module', source, shortCircuit: true };
} });
