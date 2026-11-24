// Checks tracked text files for trailing whitespace, tab characters and a
// missing final newline. Exits with status 1 and lists every problem found.

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

const CHECKED = new Set(['.js', '.mjs', '.ts', '.json', '.md', '.yml', '.yaml', '.csv']);
const NAMED = new Set(['.editorconfig', '.gitignore', 'CODEOWNERS', 'LICENSE']);
const SKIP_DIRS = new Set(['.git', 'node_modules']);

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP_DIRS.has(name)) return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function listFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' });
    return out.split('\0').filter(Boolean);
  } catch {
    return walk('.');
  }
}

const problems = [];
const files = listFiles().filter((file) => {
  const base = file.split('/').pop();
  return CHECKED.has(extname(file)) || NAMED.has(base);
});

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  if (text.length > 0 && !text.endsWith('\n')) problems.push(`${file}: missing final newline`);
  text.split('\n').forEach((line, i) => {
    if (/[ \t]+\r?$/.test(line)) problems.push(`${file}:${i + 1}: trailing whitespace`);
    if (line.includes('\t')) problems.push(`${file}:${i + 1}: tab character`);
  });
}

if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`\n${problems.length} problem${problems.length === 1 ? '' : 's'} in ${files.length} files.`);
  process.exit(1);
}
console.log(`lint: ${files.length} files clean.`);
