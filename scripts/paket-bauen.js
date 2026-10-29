#!/usr/bin/env node
// Baut das Update-Paket dist/monitoring-basis-<version>.tar.gz (Programmdateien + node_modules),
// die zugehörige .sha256-Datei und dist/notizen.md aus dem passenden CHANGELOG-Abschnitt.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wurzel = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(path.join(wurzel, 'package.json'), 'utf8'));
const dist = path.join(wurzel, 'dist');
const name = `monitoring-basis-${version}.tar.gz`;

if (!existsSync(path.join(wurzel, 'node_modules'))) throw new Error('node_modules fehlt. Zuerst "npm ci --omit=dev" ausführen.');
const tag = process.env.GITHUB_REF_NAME;
if (tag && tag !== `v${version}`) throw new Error(`Tag ${tag} passt nicht zur Version ${version} in package.json.`);

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);
const dateien = execFileSync('git', ['ls-files'], { cwd: wurzel, encoding: 'utf8' }).split('\n').filter(Boolean);
writeFileSync(path.join(dist, 'liste.txt'), [...dateien, 'node_modules'].join('\n') + '\n');
execFileSync('tar', ['-czf', path.join(dist, name), '--owner=0', '--group=0', '--numeric-owner', '-T', path.join(dist, 'liste.txt')], { cwd: wurzel, stdio: 'inherit' });
rmSync(path.join(dist, 'liste.txt'));

const hash = createHash('sha256').update(readFileSync(path.join(dist, name))).digest('hex');
writeFileSync(path.join(dist, `${name}.sha256`), `${hash}  ${name}\n`);

const changelog = readFileSync(path.join(wurzel, 'CHANGELOG.md'), 'utf8');
const abschnitt = new RegExp(`^## ${version.replaceAll('.', '\\.')}\\s*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm').exec(changelog);
if (!abschnitt) throw new Error(`CHANGELOG.md hat keinen Abschnitt "## ${version}".`);
writeFileSync(path.join(dist, 'notizen.md'), abschnitt[1].trim() + '\n');
console.log(`Paket gebaut: dist/${name} (sha256 ${hash})`);
