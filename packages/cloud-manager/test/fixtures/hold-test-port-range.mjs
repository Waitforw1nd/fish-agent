import { reserveTestPortRange } from '../port-pool.mjs';

const range = await reserveTestPortRange();
process.on('message', async message => {
  if (message !== 'release') return;
  await range.release();
  process.disconnect();
});
process.send({ start: range.start, end: range.end });
