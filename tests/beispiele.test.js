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
    assert.equal(eintrag.version, '1.0.0');
    assert.ok(Math.abs(Date.parse(eintrag.naechsterLauf) - Date.parse(eintrag.ende) - 10 * 60_000) < 1000);
  } finally {
    await rm(ordner, { recursive: true, force: true });
  }
});
