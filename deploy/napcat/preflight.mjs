import { execFileSync } from 'node:child_process';

const image = String(process.env.CLOUD_NAPCAT_IMAGE || '').trim();
const docker = process.env.CLOUD_DOCKER_PATH || 'docker';
if (!/^[-\w./:]+@sha256:[a-f0-9]{64}$/.test(image)) {
  console.error('Set CLOUD_NAPCAT_IMAGE to an administrator-verified image reference with sha256 digest.');
  process.exitCode = 1;
} else {
  try {
    execFileSync(docker, ['info', '--format', '{{.ID}}'], { stdio: 'ignore', timeout: 15000 });
    execFileSync(docker, ['image', 'inspect', image], { stdio: 'ignore', timeout: 15000 });
    console.log('Docker is reachable and the configured digest is installed. No compatibility or login test was performed.');
  } catch {
    console.error('Docker is unavailable or the configured digest is not installed.');
    process.exitCode = 1;
  }
}
