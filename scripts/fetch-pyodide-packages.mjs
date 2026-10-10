import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const directory = dirname(require.resolve('pyodide/package.json'));
const { version } = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
if (version !== '314.0.7') throw new Error('请先审查新的 Pyodide 版本与锁文件，再更新下载器。');
const lock = JSON.parse(await readFile(join(directory, 'pyodide-lock.json'), 'utf8'));
const target = fileURLToPath(new URL('../apps/web/public/code-runner/pyodide/', import.meta.url));
const selected = new Set();
function visit(name) {
  if (selected.has(name)) return;
  const entry = lock.packages[name];
  if (!entry || !/^[a-f0-9]{64}$/.test(entry.sha256) || !/^[\w.+-]+\.whl$/.test(entry.file_name)) throw new Error(`无效的锁文件条目：${name}`);
  selected.add(name); for (const dependency of entry.depends) visit(dependency);
}
for (const name of ['numpy', 'scipy', 'scikit-learn']) visit(name);
await mkdir(target, { recursive: true });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
await Promise.all([...selected].map(async name => {
  const { file_name: file, sha256: hash } = lock.packages[name];
  const path = join(target, file);
  const existing = await readFile(path).catch(() => null);
  if (existing && sha256(existing) === hash) { console.log(`已校验 ${name}`); return; }
  const url = `https://cdn.jsdelivr.net/pyodide/v${version}/full/${file}`;
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`下载 ${name} 失败：${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== hash) throw new Error(`${name} SHA-256 不匹配，拒绝安装`);
  await writeFile(`${path}.part`, bytes); await rename(`${path}.part`, path);
  console.log(`已下载并校验 ${name}（${bytes.length} 字节）`);
}));
