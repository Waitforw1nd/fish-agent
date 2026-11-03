import { registerHooks } from 'node:module';
registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (!url.endsWith('/packages/qq-agent-core/scripts/lib/download.mjs')) return result;
  const source = String(result.source);
  const target = 'got += chunk.length;';
  if (!source.includes(target)) throw new Error('negative control mutation not applied');
  return { ...result, source: source.replace(target, "stream.once('error', () => {}); got += chunk.length;") };
} });
