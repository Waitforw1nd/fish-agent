import http from 'node:http';

export class FakeDockerRunner {
  constructor() { this.networks = new Map(); this.containers = new Map(); this.calls = []; this.counter = 0; this.online = false; this.uin = '12345'; this.available = true; this.failBind = 0; this.ready = true; }
  async command(args) {
    this.calls.push([...args]);
    if (!this.available) throw Object.assign(new Error('docker unavailable'), { code: 'DOCKER_COMMAND_FAILED' });
    if (args[0] === 'info') return 'ok';
    if (args[0] === 'image') return `sha256:${'b'.repeat(64)}`;
    if (args[0] === 'network' && args[1] === 'create') {
      const id = `network-${++this.counter}`;
      const labels = this.labels(args);
      this.networks.set(id, { Labels: labels }); return id;
    }
    if (args[0] === 'network' && args[1] === 'inspect') {
      if (!this.networks.has(args[2])) throw Object.assign(new Error('no such network'), { code: 'DOCKER_NETWORK_NOT_FOUND' });
      return JSON.stringify([this.networks.get(args[2])]);
    }
    if (args[0] === 'network' && args[1] === 'rm') { this.networks.delete(args[2]); return ''; }
    if (args[0] === 'create') {
      const id = `container-${++this.counter}`;
      const mounts = this.values(args, '--mount').map(value => { const parts = Object.fromEntries(value.split(',').map(item => item.split('='))); return { Type: 'bind', RW: true, Source: parts.src, Destination: parts.dst }; });
      const ports = this.values(args, '-p').map(value => value.split(':').slice(1).map(Number));
      const networkId = args[args.indexOf('--network') + 1];
      const option = name => args[args.indexOf(name) + 1];
      const portBindings = Object.fromEntries(ports.map(([external, internal]) => [`${internal}/tcp`, [{ HostIp: '127.0.0.1', HostPort: String(external) }]]));
      const logOptions = Object.fromEntries(this.values(args, '--log-opt').map(value => value.split('=')));
      const host = { Privileged: false, PidMode: '', NetworkMode: networkId, PublishAllPorts: false, Memory: parseInt(option('--memory')) * 1048576, NanoCpus: Number(option('--cpus')) * 1e9, PidsLimit: Number(option('--pids-limit')), ShmSize: parseInt(option('--shm-size')) * 1048576, PortBindings: portBindings, LogConfig: { Config: logOptions }, RestartPolicy: { Name: 'no' } };
      this.containers.set(id, { Image: `sha256:${'b'.repeat(64)}`, Config: { Labels: this.labels(args), Image: args.at(-1) }, HostConfig: host, Mounts: mounts, NetworkSettings: { Networks: { fish: { NetworkID: networkId } } }, State: { Running: false }, ports, servers: [] });
      return id;
    }
    if (args[0] === 'inspect') return JSON.stringify([this.containers.get(args[1])]);
    if (args[0] === 'start') {
      if (this.failBind > 0) { this.failBind--; throw Object.assign(new Error('binding conflict'), { code: 'NAPCAT_PORT_CONFLICT' }); }
      const container = this.containers.get(args[1]); container.State.Running = true;
      if (this.ready) for (const [hostPort, internal] of container.ports) {
        if (internal !== 6099 && internal !== 3000) continue;
        const server = http.createServer((req, res) => {
          let data = ''; req.on('data', part => { data += part; }); req.on('end', () => {
            res.setHeader('content-type', 'application/json');
            if (req.url === '/api/auth/login') return res.end(JSON.stringify({ code: 0, data: { Credential: 'credential' } }));
            if (req.headers.authorization !== 'Bearer credential' && internal === 6099) { res.statusCode = 401; return res.end('{}'); }
            if (req.url === '/api/QQLogin/CheckLoginStatus') return res.end(JSON.stringify({ code: 0, data: { isLogin: this.online, coreReady: this.online } }));
            if (req.url === '/api/QQLogin/GetQQLoginQrcode') return res.end(JSON.stringify({ code: 0, data: { qrcode: 'https://example.com/qr' } }));
            if (req.url === '/get_login_info') return res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: this.uin, nickname: 'Fake' } }));
            res.statusCode = 404; res.end('{}');
          });
        });
        await new Promise((resolve, reject) => server.once('error', reject).listen(hostPort, '127.0.0.1', resolve));
        container.servers.push(server);
      }
      return args[1];
    }
    if (args[0] === 'stop' || args[0] === 'kill') {
      const container = this.containers.get(args.at(-1)); container.State.Running = false;
      await Promise.all(container.servers.map(server => new Promise(resolve => server.close(resolve)))); container.servers = [];
      return '';
    }
    if (args[0] === 'rm') { this.containers.delete(args[1]); return ''; }
    if (args[0] === 'logs') return 'fake runtime log';
    throw new Error(`unsupported fake docker command ${args[0]}`);
  }
  values(args, key) { return args.flatMap((v, i) => v === key ? [args[i + 1]] : []); }
  labels(args) { return Object.fromEntries(this.values(args, '--label').map(value => { const index = value.indexOf('='); return [value.slice(0, index), value.slice(index + 1)]; })); }
  async close() { for (const container of this.containers.values()) for (const server of container.servers) await new Promise(resolve => server.close(resolve)); }
}
