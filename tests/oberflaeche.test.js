import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Statische Prüfung der Oberfläche: Jede in app.js verwendete ID gibt es in index.html (sonst bricht das Skript beim Laden ab).
const html = readFileSync(new URL('../oberflaeche/index.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../oberflaeche/app.js', import.meta.url), 'utf8');
const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((t) => t[1]);

test('Oberfläche: IDs eindeutig, alle in app.js benutzten IDs vorhanden', () => {
  assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), []);
  const benutzt = new Set([...js.matchAll(/\$\('([a-z0-9-]+)'\)/g)].map((t) => t[1]));
  for (const id of [...js.matchAll(/bereichStatus\('([a-z0-9-]+)'/g)].map((t) => t[1])) benutzt.add(`${id}-status`);
  for (const k of JSON.parse(/const BEN_FELDER = (\[[^\]]+\])/.exec(js)[1].replaceAll("'", '"'))) benutzt.add(`ben-${k}`).add(`ben-${k}-fehler`);
  for (const k of JSON.parse(/const TLS_FELDER = (\[[^\]]+\])/.exec(js)[1].replaceAll("'", '"'))) benutzt.add(`tls-${k}`).add(`tls-${k}-fehler`);
  assert.ok(benutzt.size > 100);
  assert.deepEqual([...benutzt].filter((id) => !ids.includes(id)), []);
});

test('Oberfläche: ein Knopf „Einstellungen“ statt sechs, Bereiche aufklappbar mit Statuszeile', () => {
  for (const alt of ['benachrichtigung-oeffnen', 'protokoll-oeffnen', 'neustart-oeffnen', 'beenden-oeffnen', 'updates-oeffnen', 'benutzerverwaltung-oeffnen']) {
    assert.ok(!ids.includes(alt), alt);
    assert.ok(!js.includes(`'${alt}'`), alt);
  }
  assert.match(html, /id="einstellungen-oeffnen"[^>]*>Einstellungen<span id="update-hinweis"/);
  const bereiche = [...html.matchAll(/<details id="([a-z-]+)" class="bereich"([^>]*)>\s*<summary><span class="bereich-titel">([^<]+)<\/span><span id="([a-z-]+)" class="bereich-status">/g)];
  const einst = bereiche.filter((b) => b[1].startsWith('ber-'));
  assert.deepEqual(einst.map((b) => b[3]), ['HTTPS &amp; Domain', 'Benachrichtigung', 'Benutzer', 'Microsoft-Anmeldung', 'Updates', 'Fehlerprotokoll', 'Speicher', 'System']);
  for (const b of einst) assert.match(b[2], /name="einst"/); // immer nur einer offen
  assert.deepEqual(bereiche.filter((b) => b[1].startsWith('md-')).map((b) => b[3]), ['Einstellungen', 'Benachrichtigung', 'Updates', 'Kennzahlen', 'Verlauf']);
  for (const b of bereiche) assert.equal(b[4], `${b[1]}-status`);
  // Jeder Bereich der Einstellungen hat eine Ladefunktion.
  assert.deepEqual([.../const BEREICHE = \{([^}]+)\}/.exec(js)[1].matchAll(/'(ber-[a-z]+)'/g)].map((t) => t[1]), einst.map((b) => b[1]));
  // Moduleinstellungen sind kein eigener Dialog mehr.
  assert.ok(!/<dialog id="einstellungen" class="breit">\s*<div class="dialog-kopf">\s*<h2 id="einst-titel"/.test(html));
});
