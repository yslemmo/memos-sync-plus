import { cp, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
const output = resolve(root, '..');
const destination = join(output, manifest.id);
await mkdir(destination, { recursive: true });
for (const file of ['main.js', 'manifest.json', 'styles.css', 'README.md', 'LICENSE']) await cp(join(root, file), join(destination, file));
const installZip = join(output, `${manifest.id}-${manifest.version}.zip`);
// Python's standard-library zipper keeps packaging reproducible without a shell command string.
const zipper = `import pathlib, sys, zipfile
root = pathlib.Path(sys.argv[1])
target = pathlib.Path(sys.argv[2])
with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as archive:
    for file in sorted(root.rglob('*')):
        if file.is_file(): archive.write(file, file.relative_to(root.parent))
`;
execFileSync('python3', ['-c', zipper, destination, installZip]);
const sourceZip = join(output, `${manifest.id}-${manifest.version}-source.zip`);
const sourceFiles = [];
async function walk(dir) {
  for (const entry of (await readdir(dir)).sort()) {
    if (['node_modules', '.git', '.DS_Store', 'data.json', 'coverage'].includes(entry)) continue;
    const path = join(dir, entry);
    if ((await stat(path)).isDirectory()) await walk(path); else sourceFiles.push(path.slice(root.length + 1));
  }
}
await walk(root);
const sourceZipper = `import json, pathlib, sys, zipfile
root = pathlib.Path(sys.argv[1])
with zipfile.ZipFile(sys.argv[2], 'w', zipfile.ZIP_DEFLATED) as archive:
    for name in json.loads(sys.argv[3]): archive.write(root / name, pathlib.Path(root.name) / name)
`;
execFileSync('python3', ['-c', sourceZipper, root, sourceZip, JSON.stringify(sourceFiles)]);
console.log(`Install: ${installZip}\nSource:  ${sourceZip}`);
