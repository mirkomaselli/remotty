import { spawnSync } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

run(npm, ['run', 'build'], {
  REMOTTY_BASE_PATH: '/',
  REMOTTY_CAPACITOR_BUILD: '1',
});
run(npx, ['cap', 'sync', 'android']);

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
