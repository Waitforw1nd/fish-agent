// Reconstruct only the reviewed pre-fix branches in memory for negative controls.
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!url.endsWith('/packages/cloud-manager/src/relay/server.js')) return result;
  let source = String(result.source);
  const filter = `    const models = data.map((entry) => typeof entry === 'string' ? entry : entry?.id)
      .filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 200 && !id.includes(up.apiKey));`;
  const oldFilter = `    const models = data.map((entry) => typeof entry === 'string' ? entry : entry?.id).filter(Boolean);`;
  const guard = `        // A truncated stream with no complete output or usage has nothing to
        // settle. A complete empty response still settles when [DONE] arrives.
        if (!doneEvent && !usage && !completion) {
          release('upstream-incomplete-stream');
          if (!res.writableEnded) res.end();
          return;
        }
`;
  // Node propagates --experimental-loader to test workers; nested hooks may
  // therefore receive a module already transformed by this same loader.
  if (source.includes(oldFilter) && !source.includes(guard)) return result;
  if (!source.includes(filter) || !source.includes(guard)) throw new Error('Negative control anchors not found');
  source = source.replace(filter, oldFilter).replace(guard, '');
  return { ...result, source };
}
