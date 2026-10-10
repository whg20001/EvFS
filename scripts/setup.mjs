import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const password = randomBytes(18).toString('base64url');
const secret = randomBytes(32).toString('hex');
const env = `# Local development only; mock data never mixes with live data.\nAI_MODE=mock\nAPP_ORIGIN=http://127.0.0.1:3010\nAPP_ALLOWED_ORIGINS=http://localhost:3010\nOWNER_PASSWORD=${password}\nSESSION_SECRET=${secret}\nUSER_TIMEZONE=Asia/Shanghai\nAPI_HOST=127.0.0.1\nAPI_PORT=4000\n`;
try {
  await writeFile(new URL('../.env', import.meta.url), env, { flag: 'wx', mode: 0o600 });
  console.log(`已创建本地 .env（仅当前用户可读）。\n访问密码：${password}\n请保存密码，然后运行 npm run dev。\n演示地址：http://127.0.0.1:3010`);
} catch (error) {
  if (error?.code === 'EEXIST') console.log('.env 已存在，未覆盖；请使用其中的访问密码。');
  else throw error;
}
