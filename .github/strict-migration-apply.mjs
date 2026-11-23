import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const pieces = fs.readdirSync('.github/strict-payload').sort((left, right) =>
  Number(left.slice(4)) - Number(right.slice(4)));
if (pieces.length !== 7) throw new Error('Missing strict migration part');
const encoded = pieces.map((part) => fs.readFileSync('.github/strict-payload/' + part, 'utf8').trim()).join('');
const payload = zlib.brotliDecompressSync(Buffer.from(encoded, 'base64'));
if (sha256(payload) !== '7b82c0a3b270d6fe0fa2ed47232e4df5360dcbfb9a6991467ad28baecd6e12b6')
  throw new Error('Strict migration payload checksum mismatch');
const records = JSON.parse(payload.toString('utf8'));
const linesOf = (source) => {
  if (!source) return [];
  const lines = source.split(/(?<=\n)/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
};
for (const [file, digest, operations] of records) {
  if (!/^(?:bin|packages|scripts|test)\/[a-zA-Z0-9_./-]+\.ts$/.test(file) || file.includes('..'))
    throw new Error('Unexpected source path: ' + file);
  const present = fs.existsSync(file);
  if ((digest === null) === present) throw new Error('File presence mismatch: ' + file);
  const original = present ? fs.readFileSync(file, 'utf8') : '';
  if (digest && sha256(original).slice(0, 16) !== digest)
    throw new Error('Source digest mismatch: ' + file);
  const lines = linesOf(original);
  for (const [start, count, replacement] of operations.reverse())
    lines.splice(start, count, ...linesOf(replacement));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join(''));
}
if (records.length !== 104) throw new Error('Unexpected migration size: ' + records.length);
console.log('Applied full strict migration to', records.length, 'files');
