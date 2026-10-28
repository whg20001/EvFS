import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const allowed = {
  '@sanxing/contracts': [],
  '@sanxing/local-storage': [],
  '@sanxing/database': ['@sanxing/contracts', '@sanxing/local-storage'],
  '@sanxing/ai-access': ['@sanxing/contracts', '@sanxing/local-storage'],
  '@sanxing/ai-usage': ['@sanxing/contracts'],
  '@sanxing/learning-domain': ['@sanxing/contracts'],
  '@sanxing/learning-agent': ['@sanxing/contracts', '@sanxing/ai-access'],
  '@sanxing/api': ['@sanxing/local-storage', '@sanxing/contracts', '@sanxing/database', '@sanxing/ai-access', '@sanxing/ai-usage', '@sanxing/learning-domain', '@sanxing/learning-agent'],
  '@sanxing/web': ['@sanxing/contracts', '@sanxing/database', '@sanxing/learning-domain', '@sanxing/learning-agent', '@sanxing/ai-usage'],
};
const manifests = [];
for (const parent of ['apps', 'packages']) for (const entry of await readdir(join(root, parent), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const directory = join(root, parent, entry.name);
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  if (!Object.hasOwn(allowed, manifest.name)) throw new Error(`No boundary policy for ${manifest.name}`);
  manifests.push({ directory, manifest });
}
async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else if (/\.[cm]?[jt]sx?$/.test(entry.name) && !/\.(test|spec)\.[^.]+$/.test(entry.name) && !entry.name.endsWith('.d.ts')) result.push(path);
  }
  return result;
}
const violations = [];
let count = 0;
for (const { directory, manifest } of manifests) for (const path of [...await files(join(directory, 'src')), ...(manifest.name === '@sanxing/web' ? [join(directory, 'server.mjs'), ...await files(join(directory, 'code-runner'))] : [])]) {
  // The explicit custom HTTP server is Node-only; do not relax browser-source checks.
  const webServerEntry = manifest.name === '@sanxing/web' && path === join(directory, 'server.mjs');
  count++;
  const source = ts.createSourceFile(path, await readFile(path, 'utf8'), ts.ScriptTarget.Latest, true);
  function inspect(node) {
    let specifier;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specifier = node.moduleSpecifier.text;
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) specifier = node.arguments[0].text;
    if (specifier) {
      const label = `${relative(root, path)} → ${specifier}`;
      if (specifier.startsWith('.')) {
        const target = resolve(dirname(path), specifier);
        if (!target.startsWith(directory + sep)) violations.push(`${label}: cross-package relative import`);
        if (manifest.name === '@sanxing/web' && !webServerEntry && target === join(directory, 'server.mjs')) violations.push(`${label}: custom server cannot be imported by browser source`);
      } else if (specifier.startsWith('@sanxing/')) {
        const dependency = specifier.split('/').slice(0, 2).join('/');
        if (!allowed[manifest.name].includes(dependency)) violations.push(`${label}: forbidden layer dependency`);
        if (manifest.name === '@sanxing/web' && ((dependency === '@sanxing/database' && !['@sanxing/database/browser', '@sanxing/database/empty', '@sanxing/database/validation'].includes(specifier)) || (dependency === '@sanxing/learning-agent' && specifier !== '@sanxing/learning-agent/browser'))) violations.push(`${label}: Node-only entrypoint is forbidden in browser source`);
        if (!manifest.dependencies?.[dependency]) violations.push(`${label}: undeclared workspace dependency`);
      }
      if (manifest.name === '@sanxing/web' && ((!webServerEntry && specifier.startsWith('node:')) || specifier.startsWith('@earendil-works/'))) violations.push(`${label}: server-only dependency in browser source`);
    }
    ts.forEachChild(node, inspect);
  }
  inspect(source);
}
if (violations.length) { console.error(violations.join('\n')); process.exitCode = 1; }
else console.log(`Module boundaries: ${count} production source files checked; allowed dependency directions preserved.`);
