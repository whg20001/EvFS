import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const web = fileURLToPath(new URL('../', import.meta.url));
const output = join(web, 'public/code-runner');
const pyodide = dirname(require.resolve('pyodide/package.json'));
async function writeChanged(path, contents) {
  const bytes = Buffer.from(contents);
  const previous = await readFile(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!previous?.equals(bytes)) await writeFile(path, bytes);
}
await mkdir(join(output, 'pyodide'), { recursive: true });
const result = await build({ entryPoints: [join(web, 'code-runner/frame.ts'), join(web, 'code-runner/worker.ts')], outdir: output, bundle: true, platform: 'browser', format: 'iife', target: 'es2022', minify: true, write: false });
for (const file of result.outputFiles) await writeChanged(file.path, file.contents);
for (const file of ['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json']) await writeChanged(join(output, 'pyodide', file), await readFile(join(pyodide, file)));
await writeChanged(join(output, 'runner.html'), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>代码运行沙箱</title><script type="module" src="./frame.js" crossorigin="anonymous"></script></html>\n');
console.log('浏览器运行器已生成；科学计算包：npm run code-runner:packages（首次使用 Python 时安装）。');
