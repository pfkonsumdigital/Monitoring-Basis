import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ladeModule } from '../basis/module.js';
import { fuehreAus } from '../basis/ausfuehrung.js';

const beispiele = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'beispiele');

test('Beispielmodule sind gültig', async () => {
  const module = await ladeModule(beispiele);
  assert.deepEqual(module.map((m) => [m.id, m.fehler ?? null]), [['skript-beispiel', null], ['speicherplatz', null]]);
});

test('Beispiel-Plugin Speicherplatz liefert ein Ergebnis', async () => {
  const [, modul] = await ladeModule(beispiele);
  const ergebnis = await fuehreAus({ ...modul, einstellungen: { ...modul.einstellungen, pfad: process.platform === 'win32' ? 'C:\\' : '/' } });
  assert.ok(['ok', 'warnung', 'fehler'].includes(ergebnis.status));
  assert.match(ergebnis.zusammenfassung, /GB frei/);
  assert.ok(ergebnis.messwerte.gesamt_gb > 0);
});
