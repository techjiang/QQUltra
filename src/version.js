import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * 版本号从 package.json 读，不手写常量。
 * 手写的版本号迟早会和 package.json 对不上，而「机器人报的版本和实际跑的不是一个」
 * 会让排障从五分钟变成半小时。
 */
function readVersion() {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    return JSON.parse(readFileSync(pkgPath, 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const VERSION = readVersion();
export const PROJECT_NAME = 'QQUltra';
