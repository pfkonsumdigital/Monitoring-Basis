import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { starter } from '../start.js';

// Legt eine "Version" an, deren basis/main.js das angegebene Verhalten zeigt.
async function version(installOrdner, ordner, code) {
  const ziel = path.join(installOrdner, ordner, 'basis');
  await mkdir(ziel, { recursive: true });
  await writeFile(path.join(ziel, 'main.js'), `
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const install = process.env.MONITOR_INSTALL_ORDNER;
const bereit = (dann) => process.send({ typ: 'bereit' }, dann);
${code}`);
}

// Erster Lauf der Grundinstallation: neue Version eintragen und mit Update-Code beenden. Danach normal laufen.
const grundinstallation = (ziel) => `
const marke = path.join(install, 'erster-lauf-vorbei');
if (!existsSync(marke)) {
  writeFileSync(marke, '');
  writeFileSync(path.join(install, 'aktiv.json'), JSON.stringify({ aktiv: '${ziel}', vorher: '.', probe: true }));
  bereit(() => process.exit(3));
} else {
  writeFileSync(path.join(install, 'wieder-alt'), '');
  bereit(() => process.exit(0));
}`;

async function lauf(einrichten, optionen = {}) {
  const installOrdner = await mkdtemp(path.join(tmpdir(), 'mb-start-'));
  const meldungen = [];
  try {
    await einrichten(installOrdner);
    await starter({ installOrdner, log: (t) => meldungen.push(t), bereitMs: 1500, pauseMs: 50, signale: new EventEmitter(), ...optionen });
    const aktiv = JSON.parse(await readFile(path.join(installOrdner, 'aktiv.json'), 'utf8'));
    let wiederAlt = false;
    try { await readFile(path.join(installOrdner, 'wieder-alt')); wiederAlt = true; } catch { /* nicht vorhanden */ }
    return { aktiv, meldungen, wiederAlt };
  } finally {
    await rm(installOrdner, { recursive: true, force: true });
  }
}

test('Starter: Update-Neustart und Bestätigung der neuen Version', async () => {
  const { aktiv, meldungen, wiederAlt } = await lauf(async (o) => {
    await version(o, '.', grundinstallation('versionen/0.2.0'));
    await version(o, 'versionen/0.2.0', `bereit(() => process.exit(0));`);
  });
  assert.deepEqual(aktiv, { aktiv: 'versionen/0.2.0', vorher: '.', probe: false });
  assert.equal(wiederAlt, false);
  assert.ok(meldungen.some((m) => /Neue Version läuft/.test(m)));
});

test('Starter: abstürzende neue Version → automatisch zurück', async () => {
  const { aktiv, meldungen, wiederAlt } = await lauf(async (o) => {
    await version(o, '.', grundinstallation('versionen/0.2.0'));
    await version(o, 'versionen/0.2.0', `process.exit(1);`);
  });
  assert.deepEqual(aktiv, { aktiv: '.', vorher: null, probe: false });
  assert.equal(wiederAlt, true);
  assert.ok(meldungen.some((m) => /Automatisch zurück auf \./.test(m)));
});

test('Starter: hängende neue Version ohne Bereit-Meldung → beendet und zurück', async () => {
  const { aktiv, meldungen, wiederAlt } = await lauf(async (o) => {
    await version(o, '.', grundinstallation('versionen/0.2.0'));
    await version(o, 'versionen/0.2.0', `setInterval(() => {}, 1000);`);
  });
  assert.equal(aktiv.aktiv, '.');
  assert.equal(wiederAlt, true);
  assert.ok(meldungen.some((m) => /meldet sich nicht/.test(m)));
});

test('Starter: fehlende Version → zurück statt Endlosschleife', async () => {
  const { aktiv, wiederAlt } = await lauf(async (o) => {
    await version(o, '.', grundinstallation('versionen/gibt-es-nicht'));
  });
  assert.equal(aktiv.aktiv, '.');
  assert.equal(wiederAlt, true);
});

test('Starter: Absturz einer bestätigten Version → Neustart nach Pause', async () => {
  const { meldungen } = await lauf(async (o) => {
    await writeFile(path.join(o, 'aktiv.json'), JSON.stringify({ aktiv: '.', vorher: null, probe: false }));
    await version(o, '.', `
const marke = path.join(install, 'abgestuerzt');
if (!existsSync(marke)) { writeFileSync(marke, ''); process.exit(2); }
bereit(() => process.exit(0));`);
  });
  assert.ok(meldungen.some((m) => /beendet mit Code 2\. Neuer Start/.test(m)));
});
