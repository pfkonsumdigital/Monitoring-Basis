import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { befehlAusfuehren, eigeneSid, powershellPfad, rechteSetzen, SCHLUESSEL_DATEI, Tresor } from '../basis/geheimnis.js';

// Läuft nur unter Windows (GitHub Actions: Job „windows“). Prüft die echte DPAPI und icacls.
const nurWindows = { skip: process.platform !== 'win32' && 'nur unter Windows' };

test('DPAPI: verschlüsseln und öffnen (Basis und Module), falsche Schlüsseldatei', nurWindows, async () => {
  const ordner = await mkdtemp(path.join(tmpdir(), 'mb-dpapi-'));
  try {
    const t = new Tresor({ datenOrdner: ordner });
    assert.equal(t.verfuegbar, true);
    const werte = ['github_pat_11ABCDEF0123456789', 'Ümlaute ß € "Anführung" \\ Pfad', 'x'.repeat(500)];
    const zu = await t.schuetzen(werte, 'basis');
    for (const z of zu) assert.match(z, /^dpapi:v1:[A-Za-z0-9+/]+={0,2}$/);
    const [einer] = await t.schuetzen(['einzeln'], 'modul');
    assert.match(einer, /^dpapi:m1:/);
    // Neuer Tresor ohne Zwischenspeicher: echter Aufruf.
    const t2 = new Tresor({ datenOrdner: ordner });
    assert.deepEqual(await t2.oeffnen([...zu, einer, 'klartext']), [...werte, 'einzeln', 'klartext']);
    // Ein Modul öffnet seine Werte ohne die Schlüsseldatei der Basis.
    assert.equal(await new Tresor({ datenOrdner: path.join(ordner, 'anders') }).einzeln(einer), 'einzeln');
    // Andere Schlüsseldatei → DPAPI lehnt ab.
    const anders = path.join(ordner, 'anders');
    await mkdir(anders, { recursive: true });
    await writeFile(path.join(anders, SCHLUESSEL_DATEI), Buffer.alloc(32, 1).toString('base64'));
    await assert.rejects(new Tresor({ datenOrdner: anders }).oeffnen([zu[0]]), /passt nicht|DPAPI/);
  } finally { await rm(ordner, { recursive: true, force: true }); }
});

test('Dateirechte: nur SYSTEM, Administratoren und das eigene Konto', nurWindows, async () => {
  const ordner = await mkdtemp(path.join(tmpdir(), 'mb-acl-'));
  try {
    await mkdir(path.join(ordner, 'unter'));
    await writeFile(path.join(ordner, 'unter', 'datei.json'), '{}');
    const ausfuehren = befehlAusfuehren();
    const sid = await eigeneSid(ausfuehren);
    assert.match(sid, /^S-1-5-/);
    const r = await rechteSetzen([ordner], { ausfuehren, sid });
    assert.deepEqual(r.fehler, []);
    const sids = (pfad) => execFileSync(powershellPfad(), ['-NoProfile', '-Command',
      `(Get-Acl -LiteralPath '${pfad}').Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } | Sort-Object -Unique`], { encoding: 'utf8' })
      .split(/\r?\n/).filter(Boolean).sort();
    const erwartet = [...new Set(['S-1-5-18', 'S-1-5-32-544', sid])].sort();
    assert.deepEqual(sids(ordner), erwartet);
    assert.deepEqual(sids(path.join(ordner, 'unter', 'datei.json')), erwartet, 'Unterordner und Dateien erben');
    assert.ok(!sids(ordner).includes('S-1-5-32-545'), 'keine normalen Benutzer');
    // Leerer Ordner: kein Fehler.
    const leer = path.join(ordner, 'leer');
    await mkdir(leer);
    assert.deepEqual((await rechteSetzen([leer], { ausfuehren, sid })).fehler, []);
  } finally { await rm(ordner, { recursive: true, force: true }); }
});
