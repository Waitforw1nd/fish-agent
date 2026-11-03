import { registerHooks } from 'node:module';

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.endsWith('/packages/qq-agent-core/src/app.js')) return result;
    let source = String(result.source);
    const mode = process.env.FISH_NEGATIVE_MODE;
    const before = mode === 'endpoint'
      ? "startupChannels.qq.wsUrl ? '已配置' : '未配置'"
      : 'callerLog(`[${entry.module}] ${entry.text}`)';
    const after = mode === 'endpoint'
      ? 'startupChannels.qq.wsUrl'
      : 'log(`[${entry.module}] ${entry.text}`)';
    if (!['endpoint', 'callback'].includes(mode) || !source.includes(before)) throw new Error('negative control mutation not applied');
    source = source.replace(before, after);
    return { ...result, source };
  }
});
