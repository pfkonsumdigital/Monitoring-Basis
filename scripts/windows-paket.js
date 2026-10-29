#!/usr/bin/env node
// Baut das vollständige Windows-Paket dist/monitoring-basis-<version>-windows-x64.zip:
// Start.exe (aus launcher/, Go), feste Node.js-Laufzeit unter runtime\ und das Programm samt node_modules.
// Voraussetzungen: go, zip, unzip, tar; node_modules ohne Entwicklungsabhängigkeiten (npm ci --omit=dev).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Feste Laufzeit. Prüfsumme aus https://nodejs.org/dist/v22.23.4/SHASUMS256.txt
const NODE_VERSION = '22.23.4';
const NODE_SHA256 = 'cbc74b5e0982c9dbb41525fd8fb5dcd32fbee237863f7829072f4639a1ce5f20';

const wurzel = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(path.join(wurzel, 'package.json'), 'utf8'));
const dist = path.join(wurzel, 'dist');
const cache = path.join(wurzel, 'build-cache');
const ziel = path.join(dist, 'windows', 'monitoring-basis');
const zipName = `monitoring-basis-${version}-windows-x64.zip`;
const sha256 = (daten) => createHash('sha256').update(daten).digest('hex');

if (!existsSync(path.join(wurzel, 'node_modules'))) throw new Error('node_modules fehlt. Zuerst "npm ci --omit=dev" ausführen.');

// 1. Node-Laufzeit holen (zwischengespeichert) und Prüfsumme kontrollieren.
mkdirSync(cache, { recursive: true });
const nodeZip = path.join(cache, `node-v${NODE_VERSION}-win-x64.zip`);
if (!existsSync(nodeZip)) {
  const antwort = await fetch(`https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`);
  if (!antwort.ok) throw new Error(`Node.js-Download fehlgeschlagen: HTTP ${antwort.status}`);
  writeFileSync(nodeZip, Buffer.from(await antwort.arrayBuffer()));
}
const ist = sha256(readFileSync(nodeZip));
if (ist !== NODE_SHA256) {
  rmSync(nodeZip, { force: true });
  throw new Error(`Prüfsumme der Node.js-Laufzeit stimmt nicht (${ist}). Abbruch.`);
}

// 2. Programmdateien (wie im Git) und node_modules zusammenstellen.
rmSync(path.join(dist, 'windows'), { recursive: true, force: true });
mkdirSync(path.join(ziel, 'runtime'), { recursive: true });
const dateien = execFileSync('git', ['ls-files'], { cwd: wurzel, encoding: 'utf8' }).split('\n').filter(Boolean);
for (const datei of dateien) {
  mkdirSync(path.dirname(path.join(ziel, datei)), { recursive: true });
  cpSync(path.join(wurzel, datei), path.join(ziel, datei));
}
cpSync(path.join(wurzel, 'node_modules'), path.join(ziel, 'node_modules'), { recursive: true });

// 3. node.exe und Lizenz in runtime\ entpacken.
execFileSync('unzip', ['-q', '-j', nodeZip, `node-v${NODE_VERSION}-win-x64/node.exe`, `node-v${NODE_VERSION}-win-x64/LICENSE`, '-d', path.join(ziel, 'runtime')]);

// 4. Start.exe bauen (Windows-GUI-Programm, ohne Konsolenfenster).
execFileSync('go', ['build', '-trimpath', '-ldflags', '-H windowsgui -s -w', '-o', path.join(ziel, 'Start.exe'), '.'], {
  cwd: path.join(wurzel, 'launcher'), stdio: 'inherit',
  env: { ...process.env, GOOS: 'windows', GOARCH: 'amd64', CGO_ENABLED: '0' },
});

// 5. ZIP und Prüfsumme.
rmSync(path.join(dist, zipName), { force: true });
execFileSync('zip', ['-q', '-r', '-X', path.join(dist, zipName), 'monitoring-basis'], { cwd: path.join(dist, 'windows') });
rmSync(path.join(dist, 'windows'), { recursive: true, force: true });
const hash = sha256(readFileSync(path.join(dist, zipName)));
writeFileSync(path.join(dist, `${zipName}.sha256`), `${hash}  ${zipName}\n`);
console.log(`Windows-Paket gebaut: dist/${zipName} (sha256 ${hash})`);
