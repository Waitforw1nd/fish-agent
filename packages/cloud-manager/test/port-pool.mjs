import net from 'node:net';

export async function reserveTestPortRange() {
  const first = 12000;
  const last = 30000;
  const size = 128;
  const stride = size + 1;
  const slots = Math.floor((last - first + 1) / stride);
  for (let index = 0; index < slots; index += 1) {
    const anchor = first + index * stride;
    const server = net.createServer();
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen({ host: '127.0.0.1', port: anchor, exclusive: true }, resolve);
      });
    } catch (error) {
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') continue;
      throw error;
    }
    server.unref();
    // The anchor stays bound while the manager uses the rest of this range.
    return {
      start: anchor + 1,
      end: anchor + size,
      async release() {
        if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
    };
  }
  throw new Error('No test port range is available');
}
