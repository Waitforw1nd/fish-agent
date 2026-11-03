// Reproduce the pre-fix online-meter implementation without editing production files.
const { registerHooks } = require('node:module');
registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (!url.endsWith('/packages/cloud-manager/src/desktop/gateway.js')) return result;
  let source = result.source.toString();
  const before = source;
  source = source.replace('const end = meter.pendingEnd ?? meter.endedAt ?? time;', 'const end = meter.endedAt ?? time;')
    .replace(/        meter\.pendingEnd = end;\r?\n/, '')
    .replace(/          meter\.pendingEnd = null;\r?\n/, '')
    .replace('meter.cursor >= meter.endedAt', 'meter.cursor >= end');
  if (source === before || source.includes('meter.pendingEnd = end;') || source.includes('const end = meter.pendingEnd')) throw new Error('negative control did not restore the vulnerable logic');
  return { ...result, source };
} });
