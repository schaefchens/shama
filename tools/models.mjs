// Fetches embedded models from engines/sherpa/models.json – each file or archive checked against
// its size and SHA-256 – into <folder>/<language>/, with the shama-model.json the core reads. An
// app bundles that folder, or fetches the same files at run time, and names it in configure().
//
//   node tools/models.mjs <folder> <model id>...
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const catalog = JSON.parse(readFileSync(new URL('../engines/sherpa/models.json', import.meta.url), 'utf8'));
const [folder, ...ids] = process.argv.slice(2);
if (!folder || ids.length === 0 || ids.some((id) => !catalog[id])) {
  console.error(`usage: node tools/models.mjs <folder> <model id>...\nmodels: ${Object.keys(catalog).join(', ')}`);
  process.exit(1);
}

async function sha256(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/** Whether `path` is the file meant: its size, then its digest. */
async function good(path, size, digest) {
  return existsSync(path) && statSync(path).size === size && (await sha256(path)) === digest;
}

async function download(url, path, size, digest) {
  if (await good(path, size, digest)) return;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(`${path}.part`));
  if (!(await good(`${path}.part`, size, digest))) {
    rmSync(`${path}.part`);
    throw new Error(`${url}: not the file expected`);
  }
  renameSync(`${path}.part`, path);
}

for (const id of ids) {
  const model = catalog[id];
  const target = join(folder, model.language);
  mkdirSync(target, { recursive: true });
  const files = {};
  if (model.archive) {
    const [url, size, digest] = model.archive;
    const archive = join(folder, `.${basename(url)}`);
    await download(url, archive, size, digest);
    const unpacked = mkdtempSync(join(folder, '.unpack-'));
    try {
      execFileSync('tar', ['xjf', archive, '-C', unpacked]);
      const [inside] = execFileSync('ls', [unpacked], { encoding: 'utf8' }).trim().split('\n');
      for (const [part, name] of Object.entries(model.files)) {
        renameSync(join(unpacked, inside, name), join(target, name));
        files[part] = name;
      }
    } finally {
      rmSync(unpacked, { recursive: true, force: true });
    }
    rmSync(archive);
  } else {
    for (const [part, [name, size, digest]] of Object.entries(model.files)) {
      await download(model.source + name, join(target, name), size, digest);
      files[part] = name;
    }
  }
  const { language, family, license, credit } = model;
  writeFileSync(join(target, 'shama-model.json'), `${JSON.stringify({ id, language, family, files, license, credit }, null, 2)}\n`);
  console.log(`${id}: ${target}`);
}
