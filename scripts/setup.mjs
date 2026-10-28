import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const secret = randomBytes(32).toString('hex');
const env = `# Local development; learning data stays in the browser.\nAPP_STORAGE_MODE=local-first\nALLOW_REGISTRATION=true\nGATEWAY_DAILY_CALLS=200\nAI_MODE=mock\nAPP_ORIGIN=http://127.0.0.1:3010\nAPP_ALLOWED_ORIGINS=http://localhost:3010\nSESSION_SECRET=${secret}\nUSER_TIMEZONE=Asia/Shanghai\nAPI_HOST=127.0.0.1\nAPI_PORT=4000\n`;
try {
  await writeFile(new URL('../.env', import.meta.url), env, { flag: 'wx', mode: 0o600 });
  console.log('已创建本地 .env（仅当前用户可读）。\n运行 npm run dev，在登录页创建个人账号。\n演示地址：http://127.0.0.1:3010');
} catch (error) {
  if (error?.code === 'EEXIST') console.log('.env 已存在，未覆盖。默认采用本地学习库；旧服务器存储可显式设置 APP_STORAGE_MODE=server。');
  else throw error;
}
