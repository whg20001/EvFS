import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
if (existsSync(resolve(root, '.env'))) process.loadEnvFile(resolve(root, '.env'));
const project = resolve(root, process.env.BBC_OCR_PROJECT_PATH || '../BBC_OCR');
const python = resolve(root, process.env.BBC_OCR_PYTHON || resolve(project, '.venv/bin/python'));
const config = resolve(root, process.env.BBC_OCR_CONFIG || resolve(project, 'bbc-ocr.example.yaml'));
const url = new URL(process.env.OCR_SERVICE_URL || 'http://127.0.0.1:8000');
if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('The local OCR launcher requires a loopback HTTP origin. Start a remote OCR service separately.');
if (!existsSync(project) || !existsSync(python) || !existsSync(config)) throw new Error('Set BBC_OCR_PROJECT_PATH, BBC_OCR_PYTHON and BBC_OCR_CONFIG to the existing BBC_OCR installation.');
// The synchronous endpoint runs in memory. Disable jobs and bytecode writes in the sibling repository.
const child = spawn(python, ['-c', 'from bbc_ocr.cli.main import main; raise SystemExit(main())', 'serve', '--config', config, '--host', url.hostname.replace(/^\[|\]$/g, ''), '--port', url.port || '80', '--workers', '1', '--no-jobs'], {
  cwd: project, stdio: 'inherit', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', BBC_OCR_TOKEN: process.env.OCR_SERVICE_TOKEN || '', PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: 'True' },
});
child.once('error', () => { console.error('Could not start BBC_OCR. Check the Python environment and installed Paddle dependencies.'); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 0 : 1); });
