import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Anmeldung, hashPasswort } from '../basis/anmeldung.js';
import { Benachrichtigung } from '../basis/benachrichtigung.js';
import { Benutzerverwaltung } from '../basis/benutzerverwaltung.js';
import { ansicht, passwoerter, speichern, verschluesseln, wirksameWerte } from '../basis/einstellungen.js';
import { BasisFehler } from '../basis/fehler.js';
import {
  eigeneSid, istKlartext, istVerschluesselt, konfigOeffnen, konfigSchuetzen, konfigWerteOeffnen, MODUL_ENTROPIE,
  ohneModulpfad, powershellPfad, rechteSetzen, SCHLUESSEL_DATEI, Tresor,
} from '../basis/geheimnis.js';
import { pruefeKonfiguration } from '../basis/konfiguration.js';
import { pruefeModul } from '../basis/module.js';
import { Updateverwaltung } from '../basis/updates.js';
import { alteKopienLoeschen, geheimnisseUmstellen } from '../basis/umstellung.js';

// Ersatz für DPAPI: umkehrbar, mit Zufallsanteil (wie DPAPI: gleicher Klartext → verschiedene Ergebnisse),
// prüft die Zusatzentropie (falscher Schlüssel → Fehler wie bei DPAPI).
function fakeDpapi() {
  const aufrufe = [];
  let n = 0;
  const dpapi = async (aktion, eintraege) => {
    aufrufe.push({ aktion, anzahl: eintraege.length });
    return eintraege.map(({ d, e }) => {
      if (aktion === 'schuetzen') return Buffer.from(JSON.stringify({ d, e, n: n++ })).toString('base64');
      const x = JSON.parse(Buffer.from(d, 'base64').toString('utf8'));
      if (x.e !== e) throw new BasisFehler('Windows-Verschlüsselung (DPAPI) fehlgeschlagen: Wert passt nicht zu diesem Rechner oder zur Schlüsseldatei');
      return x.d;
    });
  };
  return { dpapi, aufrufe };
}
const tempOrdner = () => mkdtemp(path.join(tmpdir(), 'mb-geheim-'));
const MAIL_GEHEIM = 'Mail-Schluessel~abc.123';

test('Tresor: Präfixe, Schlüsseldatei, Zwischenspeicher, falscher Schlüssel, ohne Windows', async () => {
  const ordner = await tempOrdner();
  try {
    const { dpapi, aufrufe } = fakeDpapi();
    const t = new Tresor({ datenOrdner: ordner, dpapi });
    assert.equal(t.verfuegbar, true);
    const [a, b, leer, schon] = await t.schuetzen(['github_pat_ÄÖÜ-123', 'zweites', '', 'dpapi:v1:AAAA'], 'basis');
    assert.match(a, /^dpapi:v1:[A-Za-z0-9+/]+={0,2}$/);
    assert.equal(leer, '');
    assert.equal(schon, 'dpapi:v1:AAAA', 'schon verschlüsselte Werte bleiben');
    assert.deepEqual(aufrufe, [{ aktion: 'schuetzen', anzahl: 2 }], 'ein Aufruf für mehrere Werte');
    const schluessel = Buffer.from((await readFile(path.join(ordner, SCHLUESSEL_DATEI), 'utf8')).trim(), 'base64');
    assert.equal(schluessel.length, 32);

    const [m] = await t.schuetzen(['ftp-passwort'], 'modul');
    assert.ok(m.startsWith('dpapi:m1:'));
    assert.equal(JSON.parse(Buffer.from(m.slice(9), 'base64').toString()).e, MODUL_ENTROPIE.toString('base64'), 'Module: feste Entropie');
    assert.equal(JSON.parse(Buffer.from(a.slice(9), 'base64').toString()).e, schluessel.toString('base64'), 'Basis: Schlüsseldatei als Entropie');

    // Ein neuer Tresor (neuer Prozess) öffnet mit derselben Schlüsseldatei; Klartext und fremde Werte bleiben.
    const t2 = new Tresor({ datenOrdner: ordner, dpapi });
    assert.deepEqual(await t2.oeffnen([a, 'klartext', m, b, null]), ['github_pat_ÄÖÜ-123', 'klartext', 'ftp-passwort', 'zweites', null]);
    const vorher = aufrufe.length;
    assert.equal(await t2.einzeln(a), 'github_pat_ÄÖÜ-123');
    assert.deepEqual(await t2.schuetzen(['zweites']), [b], 'bekannter Klartext → gleicher Wert, keine neue Verschlüsselung');
    assert.equal(aufrufe.length, vorher, 'aus dem Zwischenspeicher');

    // Andere Schlüsseldatei → nicht zu öffnen. Fehlende Schlüsseldatei → klare Meldung, nichts wird neu angelegt.
    const ordner2 = await tempOrdner();
    await writeFile(path.join(ordner2, SCHLUESSEL_DATEI), Buffer.alloc(32, 7).toString('base64'));
    await assert.rejects(new Tresor({ datenOrdner: ordner2, dpapi }).oeffnen([a]), /passt nicht/);
    assert.equal(await new Tresor({ datenOrdner: ordner2, dpapi }).einzeln(m), 'ftp-passwort', 'Modulwerte brauchen die Schlüsseldatei nicht');
    const ordner3 = await tempOrdner();
    await assert.rejects(new Tresor({ datenOrdner: ordner3, dpapi }).oeffnen([a]), /Schlüsseldatei .* fehlt/);
    assert.deepEqual(await readdir(ordner3), []);
    await writeFile(path.join(ordner3, SCHLUESSEL_DATEI), 'kaputt');
    await assert.rejects(new Tresor({ datenOrdner: ordner3, dpapi }).oeffnen([a]), /beschädigt/);
    await assert.rejects(t2.oeffnen(['dpapi:v1:nicht base64!']), /beschädigt/);
    await rm(ordner2, { recursive: true, force: true });
    await rm(ordner3, { recursive: true, force: true });

    // Ohne Windows: Klartext bleibt, verschlüsselte Werte lassen sich nicht öffnen.
    const linux = new Tresor({ datenOrdner: ordner, plattform: 'linux' });
    assert.equal(linux.verfuegbar, false);
    assert.deepEqual(await linux.oeffnen(['klar', null]), ['klar', null]);
    await assert.rejects(linux.oeffnen([a]), /nur unter Windows/);
    await assert.rejects(linux.schuetzen(['x']), /nur unter Windows/);

    assert.equal(istVerschluesselt(a), true);
    assert.equal(istKlartext(a), false);
    assert.equal(istKlartext(''), false);
    assert.equal(istKlartext('x'), true);
    assert.equal(powershellPfad({ SystemRoot: 'C:\\Windows' }), 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'fester Pfad, nicht über PATH');
    assert.deepEqual(ohneModulpfad({ PATH: 'x', PSModulePath: 'C:\\ps7', psmodulepath: 'y' }), { PATH: 'x' }, 'PowerShell 5.1 ohne geerbten Modulpfad');
  } finally { await rm(ordner, { recursive: true, force: true }); }
});

test('config.json: Tokens und Zwei-Faktor-Schlüssel verschlüsseln und öffnen', async () => {
  const ordner = await tempOrdner();
  try {
    const t = new Tresor({ datenOrdner: ordner, dpapi: fakeDpapi().dpapi });
    const roh = {
      hostname: 'm.firma.de', tls: { modus: 'letsencrypt', email: 'a@b.de', dns_anbieter: 'hetzner', hetzner_token: 'HETZNER-TOKEN' },
      updates: { github_token: 'github_pat_1' },
      benutzer: { anna: { hash: 'scrypt$1$1$1$a$b', admin: true, zwei_faktor: { geheimnis: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', codes: [], seit: 'x' } }, bob: { hash: 'h' } },
    };
    const { roh: zu, anzahl } = await konfigSchuetzen(roh, t);
    assert.equal(anzahl, 3);
    assert.equal(roh.tls.hetzner_token, 'HETZNER-TOKEN', 'Original unverändert');
    assert.doesNotMatch(JSON.stringify(zu), /HETZNER-TOKEN|github_pat_1|GEZDGNBV/);
    assert.equal(zu.benutzer.anna.zwei_faktor.codes.length, 0);
    assert.equal(zu.benutzer.bob.hash, 'h');
    assert.equal((await konfigSchuetzen(zu, t)).anzahl, 0, 'schon verschlüsselt');
    // Die Prüfung lässt verschlüsselte Werte zu (z. B. für --benutzer-anlegen und den Selbsttest).
    const k = pruefeKonfiguration(zu, ordner);
    assert.match(k.tls.hetznerToken, /^dpapi:v1:/);
    const offen = await konfigWerteOeffnen(k, t);
    assert.equal(offen.tls.hetznerToken, 'HETZNER-TOKEN');
    assert.equal(offen.updates.githubToken, 'github_pat_1');
    assert.equal(offen.benutzer.anna.zwei_faktor.geheimnis, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    assert.match(k.tls.hetznerToken, /^dpapi:v1:/, 'Original unverändert');
    assert.deepEqual(await konfigOeffnen(zu, t), roh);
    // Ohne die Schlüsseldatei: Start bricht mit Abhilfe ab.
    await rm(path.join(ordner, SCHLUESSEL_DATEI));
    await assert.rejects(konfigWerteOeffnen(k, new Tresor({ datenOrdner: ordner, dpapi: fakeDpapi().dpapi })), /lassen sich nicht öffnen.*\n.*--zwei-faktor-zuruecksetzen/);
    // Entschlüsselt, aber kein gültiger Zwei-Faktor-Schlüssel.
    const t2 = new Tresor({ datenOrdner: ordner, dpapi: fakeDpapi().dpapi });
    const [falsch] = await t2.schuetzen(['kein base32'], 'basis');
    await assert.rejects(konfigWerteOeffnen({ ...k, tls: { modus: 'aus' }, updates: null, benutzer: { anna: { hash: 'h', zwei_faktor: { geheimnis: falsch, codes: [] } } } }, t2), /benutzer\.anna\.zwei_faktor ist beschädigt/);
    assert.throws(() => pruefeKonfiguration({ ...zu, benutzer: { anna: { hash: 'h', zwei_faktor: { geheimnis: 'dpapi:v2:AAAA', codes: [] } } } }, ordner), /beschädigt/);
  } finally { await rm(ordner, { recursive: true, force: true }); }
});

async function aufbau() {
  const ordner = await tempOrdner();
  const daten = path.join(ordner, 'data');
  await mkdir(daten);
  const configDatei = path.join(ordner, 'config.json');
  const roh = {
    port: 8443, tls: { modus: 'aus' }, updates: { github_token: 'github_pat_KLARTEXT_123' },
    benutzer: { anna: { hash: await hashPasswort('Blaue-Kanne-41x'), admin: true, zwei_faktor: { geheimnis: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', codes: [], seit: 'x' } } },
  };
  await writeFile(configDatei, JSON.stringify(roh, null, 2));
  const { dpapi, aufrufe } = fakeDpapi();
  const tresor = new Tresor({ datenOrdner: daten, dpapi });
  const anmeldung = new Anmeldung({ benutzer: structuredClone(roh.benutzer), sitzungMs: 60_000 });
  const log = [];
  const bv = new Benutzerverwaltung({ configDatei, anmeldung, tresor, log: (m) => log.push(m) });
  const datei = async () => JSON.parse(await readFile(configDatei, 'utf8'));
  return { ordner, daten, configDatei, tresor, anmeldung, bv, log, datei, aufrufe };
}

test('Benutzerverwaltung: Zwei-Faktor-Schlüssel in der Datei verschlüsselt, im Speicher Klartext', async () => {
  const { ordner, configDatei, anmeldung, bv, datei, tresor } = await aufbau();
  try {
    assert.equal(await bv.konfigVerschluesseln(), 2, 'GitHub-Token und Zwei-Faktor-Schlüssel');
    let roh = await datei();
    assert.doesNotMatch(JSON.stringify(roh), /github_pat_KLARTEXT|GEZDGNBV/);
    assert.ok(!(await readdir(ordner)).some((d) => d.includes('vor-benutzeraenderung')), 'keine Sicherungskopie mit Klartext');
    assert.equal(await bv.konfigVerschluesseln(), 0);

    await bv.anlegen({ name: 'bob', passwort: 'Rote-Leiter-52y' }, 'anna');
    assert.equal(anmeldung.benutzer.anna.zwei_faktor.geheimnis, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 'Speicher: Klartext');
    roh = await datei();
    assert.match(roh.benutzer.anna.zwei_faktor.geheimnis, /^dpapi:v1:/, 'Datei: verschlüsselt');
    const kopie = await readFile(`${configDatei}.vor-benutzeraenderung.json`, 'utf8');
    assert.doesNotMatch(kopie, /GEZDGNBV|github_pat_KLARTEXT/, 'auch die Sicherungskopie');

    await bv.zweiFaktorSpeichern('bob', 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', ['a'.repeat(64)]);
    roh = await datei();
    assert.match(roh.benutzer.bob.zwei_faktor.geheimnis, /^dpapi:v1:/);
    assert.equal(anmeldung.benutzer.bob.zwei_faktor.geheimnis, 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP');
    assert.equal(await tresor.einzeln(roh.benutzer.bob.zwei_faktor.geheimnis), 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP');
    assert.ok(pruefeKonfiguration(roh, ordner));
    await bv.codeVerbrauchen('bob', 'a'.repeat(64));
    assert.equal((await datei()).benutzer.bob.zwei_faktor.geheimnis, roh.benutzer.bob.zwei_faktor.geheimnis, 'unverändert, nicht neu verschlüsselt');
  } finally { await rm(ordner, { recursive: true, force: true }); }
});

test('Benachrichtigung und GitHub-Token: verschlüsselt speichern, laden, umstellen', async () => {
  const { ordner, daten, tresor } = await aufbau();
  try {
    await writeFile(path.join(daten, 'benachrichtigung.json'), JSON.stringify({ aktiv: false, tenant_id: 't', client_id: 'c', client_secret: MAIL_GEHEIM, absender: 'a@b.de', empfaenger: [] }));
    const log = [];
    const b = new Benachrichtigung({ datenOrdner: daten, tresor, log: (m) => log.push(m) });
    await b.laden();
    assert.equal(await b.verschluesseln(), 1);
    assert.equal(await b.verschluesseln(), 0);
    const roh = JSON.parse(await readFile(path.join(daten, 'benachrichtigung.json'), 'utf8'));
    assert.match(roh.client_secret, /^dpapi:v1:/);
    assert.equal(roh.client_id, 'c');
    const b2 = new Benachrichtigung({ datenOrdner: daten, tresor: new Tresor({ datenOrdner: daten, dpapi: fakeDpapi().dpapi }) });
    await b2.laden();
    assert.equal(b2.werte.client_secret, MAIL_GEHEIM);
    assert.deepEqual(b2.ansicht().werte.client_secret, { gesetzt: true });
    await b2.speichern({ tenant_id: 't2' }, 'anna');
    assert.match(JSON.parse(await readFile(path.join(daten, 'benachrichtigung.json'), 'utf8')).client_secret, /^dpapi:v1:/, 'auch nach Änderungen');
    // Nicht zu öffnen (z. B. Schlüsseldatei weg): Basis läuft weiter, Hinweis im Protokoll, Schlüssel gilt als nicht gesetzt.
    await rm(path.join(daten, SCHLUESSEL_DATEI));
    const b3 = new Benachrichtigung({ datenOrdner: daten, tresor: new Tresor({ datenOrdner: daten, dpapi: fakeDpapi().dpapi }), log: (m) => log.push(m) });
    await b3.laden();
    assert.equal(b3.werte.client_secret, '');
    assert.ok(log.some((z) => /lässt sich nicht entschlüsseln.*neu eintragen/.test(z)));
    assert.doesNotMatch(log.join('\n'), new RegExp(MAIL_GEHEIM));

    // GitHub-Token aus der Oberfläche (data/github.json).
    const t = new Tresor({ datenOrdner: daten, dpapi: fakeDpapi().dpapi });
    await writeFile(path.join(daten, 'github.json'), JSON.stringify({ github_token: 'github_pat_OBERFLAECHE_1' }));
    const v = new Updateverwaltung({ installOrdner: ordner, programmOrdner: ordner, configDatei: path.join(ordner, 'config.json'), updates: null, installiert: '0.12.0', viaStarter: true, datenOrdner: daten, tresor, fetchImpl: async () => { throw new Error('kein Netz'); } });
    v.tresor = t;
    assert.equal(await v.tokenVerschluesseln(), 1);
    assert.match(JSON.parse(await readFile(path.join(daten, 'github.json'), 'utf8')).github_token, /^dpapi:v1:/);
    await v.tokenLaden();
    assert.equal(v.oberflaechenToken, 'github_pat_OBERFLAECHE_1');
    assert.equal(await v.tokenVerschluesseln(), 0);
  } finally { await rm(ordner, { recursive: true, force: true }); }
});

test('Updates: kein Zurück auf Versionen vor 0.12.0, wenn verschlüsselt wird', async () => {
  const ordner = await tempOrdner();
  try {
    const neu = (tresor) => {
      const v = new Updateverwaltung({ installOrdner: ordner, programmOrdner: ordner, configDatei: path.join(ordner, 'config.json'), updates: null, installiert: '0.12.0', viaStarter: true, datenOrdner: ordner, tresor, neustart: () => {} });
      return v;
    };
    const t = new Tresor({ datenOrdner: ordner, dpapi: fakeDpapi().dpapi });
    for (const [version, erlaubt] of [['0.11.0', false], ['0.12.0', true]]) {
      const v = neu(t);
      v.vorherigeErmitteln = async () => ({ ordner: `versionen/${version}`, version });
      v.exklusiv = async () => 'ok';
      if (erlaubt) assert.equal(await v.zurueck(), 'ok');
      else await assert.rejects(v.zurueck(), /Zurück auf 0\.11\.0 ist nicht möglich.*0\.12\.0/);
      await v.starten().catch(() => {});
      assert.equal(Boolean(v.status().vorherige), erlaubt, 'Knopf nur, wenn erlaubt');
    }
    const ohneWindows = neu(new Tresor({ plattform: 'linux' }));
    ohneWindows.vorherigeErmitteln = async () => ({ ordner: 'versionen/0.11.0', version: '0.11.0' });
    ohneWindows.exklusiv = async () => 'ok';
    assert.equal(await ohneWindows.zurueck(), 'ok', 'ohne Verschlüsselung wie bisher');
  } finally { await rm(ordner, { recursive: true, force: true }); }
});

test('Moduleinstellungen: Passwörter nur verschlüsselt, wenn das Modul es kann', async () => {
  const ordner = await tempOrdner();
  try {
    const t = new Tresor({ datenOrdner: ordner, dpapi: fakeDpapi().dpapi });
    const felder = [{ schluessel: 'server', bezeichnung: 'Server', typ: 'text' }, { schluessel: 'passwort', bezeichnung: 'Passwort', typ: 'passwort' }];
    const kann = { id: 'ftp', ordner: path.join(ordner, 'ftp'), felder, einstellungen: {}, geheimnisse: 'dpapi' };
    const alt = { id: 'alt', ordner: path.join(ordner, 'alt'), felder, einstellungen: {}, geheimnisse: null };
    for (const m of [kann, alt]) await mkdir(m.ordner);

    assert.deepEqual((await speichern(kann, { server: 's', passwort: 'Ftp-Geheim-1' }, t)).geaendert, ['server', 'passwort']);
    let roh = JSON.parse(await readFile(path.join(kann.ordner, 'einstellungen.json'), 'utf8'));
    assert.match(roh.passwort, /^dpapi:m1:/);
    assert.equal(roh.server, 's');
    assert.equal((await wirksameWerte(kann, t)).passwort, 'Ftp-Geheim-1', 'für von der Basis gestartete Module: Klartext');
    assert.match((await wirksameWerte(kann)).passwort, /^dpapi:m1:/, 'ohne Tresor unverändert');
    assert.deepEqual((await ansicht(kann)).werte.passwort, { gesetzt: true });
    assert.deepEqual(await passwoerter(kann, t), ['Ftp-Geheim-1'], 'für den Geheimnisfilter');
    assert.deepEqual(await passwoerter(kann), [], 'ohne Tresor nichts Verschlüsseltes');
    // Nur den Server ändern: Passwort bleibt (leeres Feld = unverändert), wird nicht neu verschlüsselt.
    const vorher = roh.passwort;
    assert.deepEqual((await speichern(kann, { server: 's2', passwort: '' }, t)).geaendert, ['server']);
    assert.equal(JSON.parse(await readFile(path.join(kann.ordner, 'einstellungen.json'), 'utf8')).passwort, vorher);

    // Altes Modul ohne „geheimnisse“: bleibt Klartext, damit es weiter funktioniert.
    await speichern(alt, { passwort: 'Alt-Geheim-2' }, t);
    assert.equal(JSON.parse(await readFile(path.join(alt.ordner, 'einstellungen.json'), 'utf8')).passwort, 'Alt-Geheim-2');
    assert.equal(await verschluesseln(alt, t), 0);
    // Umstellung, sobald das Modul es kann (z. B. nach einem Modul-Update).
    assert.equal(await verschluesseln({ ...alt, geheimnisse: 'dpapi' }, t), 1);
    roh = JSON.parse(await readFile(path.join(alt.ordner, 'einstellungen.json'), 'utf8'));
    assert.match(roh.passwort, /^dpapi:m1:/);
    assert.equal(await verschluesseln({ ...alt, geheimnisse: 'dpapi' }, new Tresor({ plattform: 'linux' })), 0, 'ohne Windows nichts');

    // module.json: „geheimnisse“ nur mit dem Wert "dpapi".
    const basis = { id: 'x', name: 'X', typ: 'eigenstaendig' };
    const pruefe = (roh) => pruefeModul(roh, 'x', path.join(ordner, 'x'));
    assert.equal(pruefe({ ...basis, geheimnisse: 'dpapi' }).modul.geheimnisse, 'dpapi');
    assert.equal(pruefe(basis).modul.geheimnisse, null);
    assert.match(pruefe({ ...basis, geheimnisse: 'ja' }).fehler, /geheimnisse muss "dpapi" sein/);
  } finally { await rm(ordner, { recursive: true, force: true }); }
});

test('Umstellung nach dem Start: alles verschlüsseln, alte Kopien löschen, Dateirechte setzen', async () => {
  const { ordner, daten, configDatei, tresor, bv, datei } = await aufbau();
  try {
    const module = path.join(ordner, 'modules');
    await mkdir(module);
    await writeFile(`${configDatei}.backup-0f8e9c1a-1111-4222-8333-944455556666.json`, 'KLARTEXT');
    await writeFile(`${configDatei}.vor-benutzeraenderung.json`, 'KLARTEXT');
    await writeFile(path.join(ordner, 'config.example.json'), '{}');
    await writeFile(path.join(ordner, 'config.json.backup-notiz.txt'), 'bleibt');
    const aufrufe = [];
    const ausfuehren = async (programm, args) => {
      aufrufe.push([programm, ...args]);
      if (programm === 'whoami') return { code: 0, ausgabe: '"we-it01\\patrick","S-1-5-21-1-2-3-1001"\r\n' };
      if (programm === 'sc.exe') return { code: 0, ausgabe: `[SC] QueryServiceConfig SUCCESS\r\n\r\nSERVICE_NAME: ${args[1]}\r\n        SERVICE_START_NAME : ${args[1] === 'MonitoringFTP' ? 'KONSUM\\pfischer' : 'LocalSystem'}\r\n` };
      return { code: 0, ausgabe: 'Successfully processed 1 files' };
    };
    const log = [];
    const ergebnis = await geheimnisseUmstellen({
      tresor, configDatei, konfig: { datenOrdner: daten, moduleOrdner: module }, benutzerverwaltung: bv,
      updates: { tokenVerschluesseln: async () => 1 }, benachrichtigung: { verschluesseln: async () => 0 },
      module: { geheimnisseVerschluesseln: async () => ({ verschluesselt: 1, klartext: ['Altes Modul'] }),
        module: [{ id: 'ftp', ordner: path.join(module, 'ftp'), dienst: 'MonitoringFTP' }, { id: 'sys', ordner: path.join(module, 'sys'), dienst: 'SysDienst' }, { id: 'ohne', ordner: path.join(module, 'ohne') }, { id: 'kaputt', fehler: 'x', dienst: 'X' }] },
      log: (m) => log.push(m), ausfuehren,
    });
    assert.equal(ergebnis.verschluesselt, 4);
    assert.doesNotMatch(JSON.stringify(await datei()), /github_pat_KLARTEXT|GEZDGNBV/);
    assert.deepEqual(ergebnis.kopien.sort(), ['config.json.backup-0f8e9c1a-1111-4222-8333-944455556666.json', 'config.json.vor-benutzeraenderung.json']);
    assert.deepEqual((await readdir(ordner)).sort(), ['config.example.json', 'config.json', 'config.json.backup-notiz.txt', 'data', 'modules'], 'nur die eigenen Kopien gelöscht');
    assert.ok(log.some((z) => /Altes Modul/.test(z)));
    // icacls über SIDs: SYSTEM, Administratoren und das Konto der Basis; Vererbung aus, Unterordner zurückgesetzt.
    const icacls = aufrufe.filter((a) => a[0] === 'icacls');
    assert.deepEqual(icacls[0], ['icacls', daten, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', '*S-1-5-21-1-2-3-1001:(OI)(CI)F', '/Q']);
    assert.deepEqual(icacls[1], ['icacls', path.win32.join(daten, '*'), '/reset', '/T', '/C', '/Q']);
    assert.equal(icacls[2][1], module);
    assert.deepEqual(ergebnis.rechte.ok, [daten, module]);
    // Dienst unter eigenem Konto: Zugriff nur auf den eigenen Modulordner; SYSTEM-Dienste brauchen nichts.
    assert.deepEqual(aufrufe.filter((a) => a[0] === 'sc.exe').map((a) => a[2]), ['MonitoringFTP', 'SysDienst']);
    assert.deepEqual(icacls[4], ['icacls', path.join(module, 'ftp'), '/grant', 'KONSUM\\pfischer:(OI)(CI)M', '/T', '/C', '/Q']);
    assert.equal(icacls.length, 5);
    assert.ok(log.some((z) => /Dienstkonten haben Zugriff.*ftp \(KONSUM\\pfischer\)/.test(z)));
    assert.doesNotMatch(log.join('\n'), /github_pat_KLARTEXT|GEZDGNBV/, 'keine Werte im Protokoll');

    // Zweiter Start: nichts mehr zu tun, keine Kopien gelöscht.
    await writeFile(`${configDatei}.vor-benutzeraenderung.json`, 'neu');
    const zweite = await geheimnisseUmstellen({ tresor, configDatei, konfig: { datenOrdner: daten, moduleOrdner: module }, benutzerverwaltung: bv,
      updates: { tokenVerschluesseln: async () => 0 }, benachrichtigung: { verschluesseln: async () => 0 }, module: { geheimnisseVerschluesseln: async () => ({ verschluesselt: 0, klartext: [] }) }, log: () => {}, ausfuehren });
    assert.equal(zweite.verschluesselt, 0);
    assert.ok((await readdir(ordner)).includes('config.json.vor-benutzeraenderung.json'));

    // Fehler beim Setzen der Rechte und SYSTEM als Konto: Warnung, SID nicht doppelt.
    const fehlerLog = [];
    const r = await rechteSetzen(['C:\\x'], { sid: 'S-1-5-18', ausfuehren: async () => ({ code: 5, ausgabe: 'Zugriff verweigert\r\n' }) });
    assert.deepEqual(r.konten, ['S-1-5-18', 'S-1-5-32-544']);
    assert.deepEqual(r.fehler, ['C:\\x: Zugriff verweigert']);
    const leer = await rechteSetzen(['C:\\leer'], { sid: null, ausfuehren: async (p, a) => (a.includes('/reset') ? { code: 2, ausgabe: 'Das System kann die angegebene Datei nicht finden.' } : { code: 0, ausgabe: '' }) });
    assert.deepEqual(leer.ok, ['C:\\leer'], 'leerer Ordner ist kein Fehler');
    assert.equal(await eigeneSid(async () => ({ code: 0, ausgabe: '"nt-autorität\\system","S-1-5-18"' })), 'S-1-5-18');
    assert.equal(await eigeneSid(async () => ({ code: 1, ausgabe: '' })), null);
    void fehlerLog;

    // Ohne Windows: nur ein Hinweis, nichts wird angefasst.
    const hinweis = [];
    assert.deepEqual(await geheimnisseUmstellen({ tresor: new Tresor({ plattform: 'linux' }), log: (m) => hinweis.push(m) }), { verschluesselt: 0 });
    assert.match(hinweis.join(), /nur unter Windows/);
    assert.deepEqual(await alteKopienLoeschen(path.join(ordner, 'gibt-es-nicht', 'config.json')), []);
  } finally { await rm(ordner, { recursive: true, force: true }); }
});
