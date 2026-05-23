import { spawnSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const targets = ['src', 'scripts'];
const files = [];

async function collect(dir) {
  const dirents = await fsp.readdir(dir, { withFileTypes: true });
  for (const dirent of dirents) {
    const fullPath = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      await collect(fullPath);
      continue;
    }
    if (dirent.isFile() && dirent.name.endsWith('.js')) {
      files.push(fullPath);
    }
  }
}

for (const target of targets) {
  await collect(path.join(root, target));
}

let failed = false;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {
    cwd: root,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    failed = true;
    process.stderr.write(result.stderr || result.stdout);
  }
}

if (failed) {
  process.exitCode = 1;
} else {
  process.stdout.write(`Checked ${files.length} JavaScript files.\n`);
}
