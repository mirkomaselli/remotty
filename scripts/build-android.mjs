import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const gradle = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
const androidDir = path.resolve('android');
const javaHome = findJavaHome();

run(npm, ['run', 'android:sync']);
run(gradle, ['assembleDebug'], androidDir, javaHome ? { JAVA_HOME: javaHome } : {});

function findJavaHome() {
  if (process.env.JAVA_HOME) return process.env.JAVA_HOME;
  if (process.platform === 'darwin') {
    const androidStudioJdk = '/Applications/Android Studio.app/Contents/jbr/Contents/Home';
    if (existsSync(path.join(androidStudioJdk, 'bin', 'java'))) return androidStudioJdk;
    const result = spawnSync('/usr/libexec/java_home', ['-v', '21'], { encoding: 'utf8' });
    if (result.status === 0) return result.stdout.trim();
  }
  return null;
}

function run(command, args, cwd = process.cwd(), extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
