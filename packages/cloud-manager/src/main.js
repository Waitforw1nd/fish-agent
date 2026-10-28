import { CloudManager } from './app.js';

async function main() {
  const manager = new CloudManager();
  const info = await manager.start();
  if (info.bootstrap?.generated) {
    process.stdout.write('\n============================================================\n');
    process.stdout.write('  首次启动：已创建管理员账号\n');
    process.stdout.write(`  用户名: ${info.bootstrap.user.username}\n`);
    process.stdout.write(`  初始密码: ${info.bootstrap.password}\n`);
    process.stdout.write('  此密码只显示一次，请立即登录并妥善保存。\n');
    process.stdout.write('============================================================\n\n');
  } else if (info.bootstrap) {
    process.stdout.write(`[cloud-manager] 已创建管理员 ${info.bootstrap.user.username}\n`);
  }
  process.stdout.write(`[cloud-manager] panel: http://127.0.0.1:${info.port}  relay: http://127.0.0.1:${info.relayPort}/v1\n`);

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`[cloud-manager] ${signal} received, shutting down...\n`);
    try {
      await manager.stop();
    } catch (error) {
      process.stderr.write(`[cloud-manager] shutdown error: ${error?.stack || error}\n`);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (error) => {
    process.stderr.write(`[cloud-manager] uncaughtException: ${error?.stack || error}\n`);
  });
  process.on('unhandledRejection', (error) => {
    process.stderr.write(`[cloud-manager] unhandledRejection: ${error?.stack || error}\n`);
  });
}

main().catch((error) => {
  process.stderr.write(`[cloud-manager] startup failed: ${error?.stack || error}\n`);
  process.exit(1);
});
