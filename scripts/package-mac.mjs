import { packager } from '@electron/packager';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
fs.mkdirSync(path.join(root, '.desktop-test'), { recursive: true });
const staging = fs.mkdtempSync(path.join(root, '.desktop-test/package-'));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
for (const directory of ['desktop', 'server', 'dist', 'src/shared']) {
  fs.cpSync(path.join(root, directory), path.join(staging, directory), {
    recursive: true,
    filter: (source) => !source.split(path.sep).some((part) => ['__tests__', '__pycache__'].includes(part)),
  });
}
for (const notice of ['LICENSE', 'ACKNOWLEDGEMENTS.md']) {
  fs.copyFileSync(path.join(root, notice), path.join(staging, notice));
}
fs.writeFileSync(path.join(staging, 'package.json'), JSON.stringify({
  name: manifest.name, productName: manifest.productName, version: manifest.version,
  main: manifest.main, type: 'module', license: manifest.license,
}));

// Copy only the production dependency graph, dereferencing pnpm links. Nested
// version conflicts are retained instead of accidentally flattening them away.
function copyDependency(name, from, to, ancestors = new Map()) {
  const require = createRequire(path.join(from, 'package.json'));
  const dependencyPath = require.resolve.paths(name).map((dir) => path.join(dir, name))
    .find((dir) => fs.existsSync(path.join(dir, 'package.json')));
  if (!dependencyPath) throw new Error(`Missing runtime dependency ${name} from ${from}`);
  const source = fs.realpathSync(dependencyPath);
  if (ancestors.get(name) === source) return;
  const destination = path.join(to, 'node_modules', name);
  if (fs.existsSync(destination)) return;
  fs.cpSync(source, destination, {
    recursive: true,
    filter: (entry) => entry === source || !entry.slice(source.length + 1).split(path.sep).includes('node_modules'),
  });
  const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  const next = new Map(ancestors).set(name, source);
  for (const child of Object.keys(pkg.dependencies || {})) copyDependency(child, source, destination, next);
}
for (const name of Object.keys(manifest.dependencies)) copyDependency(name, root, staging);
const outputs = await packager({
  dir: staging, out: path.join(root, 'release'), name: 'sparkDash',
  platform: 'darwin', arch: 'arm64', electronVersion: manifest.devDependencies.electron,
  appBundleId: 'local.sparkdash.desktop', appVersion: manifest.version,
  overwrite: true, prune: false, asar: { unpack: '**/ssh-askpass.sh' },
  osxSign: { identity: '-', identityValidation: false, optionsForFile: () => ({ hardenedRuntime: false }) },
});
for (const output of outputs) {
  // Packager can report signing failures as warnings. An invalid .app must not
  // be advertised as a successful build.
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', path.join(output, 'sparkDash.app')], { stdio: 'inherit' });
  console.log(output);
}
