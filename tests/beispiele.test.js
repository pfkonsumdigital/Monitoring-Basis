import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ladeModule } from '../basis/module.js';
import { fuehreAus } from '../basis/ausfuehrung.js';
import { leseStatus } from '../basis/modulansicht.js';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const beispiele = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'beispiele');

test('Beispielmodule sind gültig', async () => {
  const module = await ladeModule(beispiele);
  assert.deepEqual(module.map((m) => [m.id, m.fehler ?? null]), [['ordnerpruefung', null], ['skript-beispiel', null], ['speicherplatz', null]]);
});

test('Beispiel-Plugin Speicherplatz liefert ein Ergebnis', async () => {
  const modul = (await ladeModule(beispiele)).find((m) => m.id === 'speicherplatz');
  const ergebnis = await fuehreAus({ ...modul, einstellungen: { ...modul.einstellungen, pfad: process.platform === 'win32' ? 'C:\\' : '/' } });
  assert.ok(['ok', 'warnung', 'fehler'].includes(ergebnis.status));
  assert.match(ergebnis.zusammenfassung, /GB frei/);
  assert.ok(ergebnis.messwerte.gesamt_gb > 0);
});

test('Eigenständiges Beispielmodul: liest Einstellungen, schreibt gültige status.json – ganz ohne Basis', async () => {
  const ordner = await mkdtemp(path.join(tmpdir(), 'mb-bsp-'));
  try {
    await cp(path.join(beispiele, 'ordnerpruefung'), ordner, { recursive: true });
    const pruef = path.join(ordner, 'pruefordner');
    await (await import('node:fs/promises')).mkdir(pruef);
    await writeFile(path.join(pruef, 'neu.csv'), 'x');
    await writeFile(path.join(pruef, 'alt.csv'), 'x');
    const alt = new Date(Date.now() - 5 * 3_600_000);
    await utimes(path.join(pruef, 'alt.csv'), alt, alt);

    execFileSync(process.execPath, [path.join(ordner, 'modul.js'), '--einmal']);
    let { eintrag } = leseStatus(await readFile(path.join(ordner, 'status.json'), 'utf8'));
    assert.equal(eintrag.status, 'fehler', 'ohne Einstellungen');
    assert.match(eintrag.zusammenfassung, /Kein Ordner/);

    await writeFile(path.join(ordner, 'einstellungen.json'), JSON.stringify({ ordner: pruef, max_alter_stunden: 2, takt_minuten: 10 }));
    execFileSync(process.execPath, [path.join(ordner, 'modul.js'), '--einmal']);
    ({ eintrag } = leseStatus(await readFile(path.join(ordner, 'status.json'), 'utf8')));
    assert.equal(eintrag.status, 'warnung');
    assert.deepEqual(eintrag.messwerte, { dateien: 2, veraltet: 1 });
    assert.match(eintrag.details[0], /^alt\.csv/);
    assert.equal(eintrag.version, '1.1.1');
    assert.ok(Math.abs(Date.parse(eintrag.naechsterLauf) - Date.parse(eintrag.ende) - 10 * 60_000) < 1000);
  } finally {
    await rm(ordner, { recursive: true, force: true });
  }
});

test('Eigenständiges Beispielmodul: alter Befehl beim Start gilt nicht, befehl.json beendet den Dauerbetrieb', async () => {
  const { spawn } = await import('node:child_process');
  const ordner = await mkdtemp(path.join(tmpdir(), 'mb-bsp-'));
  try {
    await cp(path.join(beispiele, 'ordnerpruefung'), ordner, { recursive: true });
    const befehl = path.join(ordner, 'befehl.json');
    await writeFile(befehl, JSON.stringify({ befehl: 'beenden', zeit: '2026-10-01T00:00:00Z', von: 'alt' }));
    const kind = spawn(process.execPath, [path.join(ordner, 'modul.js')], { stdio: 'ignore' });
    const ende = new Promise((r) => kind.once('exit', (code) => r(code)));
    let beendet = false;
    ende.then(() => { beendet = true; });
    await new Promise((r) => setTimeout(r, 3000));
    assert.equal(beendet, false, 'läuft trotz altem Befehl weiter');
    assert.ok(JSON.parse(await readFile(path.join(ordner, 'status.json'), 'utf8')).zeit, 'hat einen Lauf gemeldet');
    await writeFile(befehl, JSON.stringify({ befehl: 'beenden', zeit: new Date().toISOString(), von: 'patrick' }));
    const code = await Promise.race([ende, new Promise((r) => setTimeout(() => r('zu langsam'), 6000))]);
    if (code === 'zu langsam') kind.kill();
    assert.equal(code, 0);
    await assert.rejects(readFile(befehl), /ENOENT/, 'Befehl wurde entfernt');
  } finally {
    await rm(ordner, { recursive: true, force: true });
  }
});
