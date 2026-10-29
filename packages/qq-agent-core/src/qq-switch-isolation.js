import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_QQ = { start: 1, end: 2 ** 52 - 1 };
const DEFAULT_BILI = { start: 2 ** 52, end: Number.MAX_SAFE_INTEGER };

function range(value, fallback) {
  const start = Number(Array.isArray(value) ? value[0] : value?.start ?? fallback.start);
  const end = Number(Array.isArray(value) ? value[1] : value?.end ?? fallback.end);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) throw new Error('通道号码段无效，无法隔离旧 QQ 任务');
  return { start, end };
}

function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.switch.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function isolateQqSwitchTasks(dataDir, { operationId = '', stoppedAt = Date.now() } = {}) {
  const configFile = path.join(dataDir, 'config.json');
  let config = {};
  if (fs.existsSync(configFile)) config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const qq = range(config.channels?.qq?.idRange, DEFAULT_QQ);
  const bili = range(config.channels?.bili?.idRange, DEFAULT_BILI);
  if (!(qq.end < bili.start || bili.end < qq.start)) throw new Error('QQ 与 B站号码段重叠，无法隔离旧任务');
  const isQq = (key) => {
    const match = /^(?:group|private):(\d+)$/.exec(String(key || ''));
    if (!match) return false;
    const id = Number(match[1]);
    return Number.isSafeInteger(id) && id >= qq.start && id <= qq.end;
  };
  const files = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => path.join(dir, name)) : [];
  let messages = 0, sessions = 0;
  for (const file of files(path.join(dataDir, 'messages'))) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!isQq(data.chatKey) || !Array.isArray(data.messages)) continue;
    let changed = false;
    for (const message of data.messages) {
      if (!message.self && !message.read) {
        message.read = true;
        message.interruptedByQqSwitch = operationId || true;
        messages++;
        changed = true;
      }
    }
    if (changed) writeJson(file, data);
  }
  for (const file of files(path.join(dataDir, 'sessions'))) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!isQq(data.chatKey)) continue;
    const active = data.status === 'running' || data.status === 'waiting';
    const recentlyAborted = data.status === 'aborted' && Number(data.endedAt || 0) >= stoppedAt;
    if (!active && !recentlyAborted) continue;
    data.status = 'aborted';
    data.endedAt ||= Date.now();
    data.interruptedByQqSwitch = operationId || true;
    data.sendResult = 'unknown';
    writeJson(file, data);
    sessions++;
  }
  if (sessions) fs.rmSync(path.join(dataDir, 'session-index-cache.json'), { force: true });
  return { messages, sessions };
}
