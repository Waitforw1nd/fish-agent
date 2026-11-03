import { registerHooks } from 'node:module';
registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (!url.endsWith('/packages/qq-agent-core/scripts/lib/download.mjs')) return result;
  let source = String(result.source).replace(/\r\n/g, '\n');
  const target = `  try {\r\n    fs.renameSync(partPath, dest);\r\n  } catch (error) {\r\n    renderer.fail();\r\n    try { fs.unlinkSync(partPath); } catch { /* preserve the rename error */ }\r\n    throw error;\r\n  }\r\n  renderer.done({ got, total, elapsedMs: Date.now() - startedAt });`;
  const normalizedTarget = target.replace(/\r\n/g, '\n');
  if (!source.includes(normalizedTarget)) throw new Error('negative control mutation not applied');
  source = source.replace(normalizedTarget, '  fs.renameSync(partPath, dest);');
  const marker = '  if (total && got !== total) {';
  if (!source.includes(marker)) throw new Error('completion marker not found');
  source = source.replace(marker, '  renderer.done({ got, total, elapsedMs: Date.now() - startedAt });\r\n\r\n' + marker);
  return { ...result, source };
} });
