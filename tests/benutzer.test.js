import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Anmeldung, hashPasswort, passwortStimmt } from '../basis/anmeldung.js';
import { Benutzerverwaltung } from '../basis/benutzerverwaltung.js';
import { pruefeKonfiguration } from '../basis/konfiguration.js';
import { erstelleAnwendung, starteServer } from '../basis/webserver.js';

const PW = 'anna-passwort-1';

async function aufbau() {
  const ordner = await mkdtemp(path.join(tmpdir(), 'mb-benutzer-'));
  const configDatei = path.join(ordner, 'config.json');
  const roh = { port: 8443, tls: { modus: 'aus' }, benutzer: { anna: { hash: await hashPasswort(PW), admin: true } }, updates: { github_token: 'geheim-token' } };
  await writeFile(configDatei, JSON.stringify(roh));
  const anmeldung = new Anmeldung({ benutzer: roh.benutzer, sitzungMs: 60_000 });
  const log = [];
  const bv = new Benutzerverwaltung({ configDatei, anmeldung, log: (m) => log.push(m) });
  const datei = async () => JSON.parse(await readFile(configDatei, 'utf8'));
  return { ordner, configDatei, anmeldung, bv, log, datei };
}

test('Benutzerverwaltung: anlegen, Passwort setzen, Admin-Recht, löschen – gespeichert in config.json', async () => {
  const { ordner, configDatei, anmeldung, bv, log, datei } = await aufbau();
  try {
    await bv.anlegen({ name: 'bob', passwort: 'bob-passwort-1', admin: false }, 'anna');
    let roh = await datei();
    assert.deepEqual(Object.keys(roh.benutzer), ['anna', 'bob']);
    assert.equal(await passwortStimmt('bob-passwort-1', roh.benutzer.bob.hash), true);
    assert.equal(roh.benutzer.bob.admin, undefined);
    assert.equal(roh.updates.github_token, 'geheim-token', 'übrige Einstellungen bleiben');
    assert.ok(pruefeKonfiguration(roh, ordner), 'config.json bleibt gültig');
    assert.ok((await readdir(ordner)).includes('config.json.vor-benutzeraenderung.json'), 'Sicherungskopie');
    assert.equal(typeof await anmeldung.anmelden('bob', 'bob-passwort-1', 'ip'), 'string', 'sofort anmeldbar, ohne Neustart');

    for (const [eingabe, fehler] of [
      [{ name: 'bob', passwort: 'irgendwas-langes' }, /gibt es schon/],
      [{ name: 'carl', passwort: 'kurz' }, /mindestens 10 Zeichen/],
      [{ name: 'carl', passwort: 'x'.repeat(201) }, /höchstens 200/],
      [{ name: 'carl mit leer', passwort: 'irgendwas-langes' }, /Benutzername/],
      [{ name: '__proto__', passwort: 'irgendwas-langes' }, /Benutzername/],
      [{ name: '', passwort: 'irgendwas-langes' }, /Benutzername/],
    ]) await assert.rejects(bv.anlegen(eingabe, 'anna'), fehler, JSON.stringify(eingabe).slice(0, 40));

    // Passwort setzen beendet alle Sitzungen des Benutzers.
    const t1 = await anmeldung.anmelden('bob', 'bob-passwort-1', 'ip');
    await bv.passwortSetzen('bob', 'bob-passwort-2', 'anna');
    assert.equal(anmeldung.sitzung(t1), null);
    assert.equal(await anmeldung.anmelden('bob', 'bob-passwort-1', 'ip9'), null);
    assert.equal(typeof await anmeldung.anmelden('bob', 'bob-passwort-2', 'ip'), 'string');
    await assert.rejects(bv.passwortSetzen('niemand', 'irgendwas-langes', 'anna'), /gibt es nicht/);

    // Admin-Recht: wirkt sofort in laufenden Sitzungen; eigenes Recht und letzter Admin geschützt.
    const tBob = await anmeldung.anmelden('bob', 'bob-passwort-2', 'ip');
    await bv.adminSetzen('bob', true, 'anna');
    assert.equal(anmeldung.sitzung(tBob).admin, true);
    assert.equal((await datei()).benutzer.bob.admin, true);
    await assert.rejects(bv.adminSetzen('anna', false, 'anna'), /eigene Admin-Recht/);
    await bv.adminSetzen('anna', false, 'bob');
    await assert.rejects(bv.adminSetzen('bob', false, 'anna'), /letzte Admin/);
    await bv.adminSetzen('anna', true, 'bob');
    await bv.adminSetzen('bob', false, 'anna');
    assert.equal(anmeldung.sitzung(tBob).admin, false);
    assert.equal('admin' in (await datei()).benutzer.bob, false);

    // Löschen: Sitzungen enden; eigenes Konto und letzter Admin geschützt.
    await assert.rejects(bv.loeschen('anna', 'anna'), /eigene Konto/);
    await bv.anlegen({ name: 'chef', passwort: 'chef-passwort-1', admin: true }, 'anna');
    await bv.loeschen('bob', 'anna');
    assert.equal(anmeldung.sitzung(tBob), null);
    assert.deepEqual(Object.keys((await datei()).benutzer), ['anna', 'chef']);
    await bv.adminSetzen('anna', false, 'chef');
    await assert.rejects(bv.loeschen('chef', 'anna'), /letzte Admin/);
    await assert.rejects(bv.loeschen('niemand', 'chef'), /gibt es nicht/);

    assert.ok(log.includes('Benutzer bob angelegt durch anna.'));
    assert.ok(log.some((z) => /^Passwort von bob geändert durch anna \(2 Sitzung\(en\) beendet\)\.$/.test(z)));
    assert.ok(log.includes('Admin-Recht von bob vergeben durch anna.'));
    assert.ok(log.some((z) => z.startsWith('Benutzer bob gelöscht durch anna')));
    assert.doesNotMatch(JSON.stringify(log), /passwort-\d|scrypt/, 'keine Passwörter oder Hashes im Protokoll');
    assert.equal((await readdir(ordner)).filter((n) => n.endsWith('.tmp')).length, 0);
    void configDatei;
  } finally { await rm(ordner, { recursive: true, force: true }); }
});

test('Eigenes Passwort: bisheriges nötig, Sperre nach Fehlversuchen, eigene Sitzung bleibt', async () => {
  const { ordner, anmeldung, bv } = await aufbau();
  try {
    const eigen = await anmeldung.anmelden('anna', PW, 'ip1');
    const anderes = await anmeldung.anmelden('anna', PW, 'ip2');
    await assert.rejects(bv.eigenesPasswort('anna', 'falsch', 'neues-passwort-1', eigen, 'ip1'), /bisherige Passwort stimmt nicht/);
    await assert.rejects(bv.eigenesPasswort('anna', PW, PW, eigen, 'ip1'), /unterscheiden/);
    await assert.rejects(bv.eigenesPasswort('anna', PW, 'kurz', eigen, 'ip1'), /10 Zeichen/);
    await bv.eigenesPasswort('anna', PW, 'neues-passwort-1', eigen, 'ip1');
    assert.equal(anmeldung.sitzung(eigen).benutzer, 'anna', 'eigene Sitzung bleibt');
    assert.equal(anmeldung.sitzung(anderes), null, 'andere Sitzung endet');
    for (let i = 0; i < 4; i++) await assert.rejects(bv.eigenesPasswort('anna', 'falsch', 'x-passwort-123', eigen, 'ip3'), /stimmt nicht/);
    await assert.rejects(bv.eigenesPasswort('anna', 'falsch', 'x-passwort-123', eigen, 'ip3'), /Zu viele Fehlversuche/);
    await assert.rejects(bv.eigenesPasswort('anna', 'neues-passwort-1', 'x-passwort-123', eigen, 'ip3'), /Zu viele Fehlversuche/);
  } finally { await rm(ordner, { recursive: true, force: true }); }
});

test('Angemeldet: Adresse, seit, zuletzt aktiv, Ablauf; ohne Token', async () => {
  let zeit = Date.parse('2026-10-30T10:00:00Z');
  const a = new Anmeldung({ benutzer: { anna: { hash: await hashPasswort(PW), admin: true }, bob: { hash: await hashPasswort('bob-passwort-1') } }, sitzungMs: 3_600_000, jetzt: () => zeit });
  const tA = await a.anmelden('anna', PW, '::ffff:10.0.0.7');
  zeit += 60_000;
  const tB = await a.anmelden('bob', 'bob-passwort-1', '10.0.0.8');
  zeit += 60_000;
  a.sitzung(tA);
  const liste = a.liste(tB);
  assert.deepEqual(liste, [
    { benutzer: 'anna', admin: true, adresse: '::ffff:10.0.0.7', seit: '2026-10-30T10:00:00.000Z', zuletzt: '2026-10-30T10:02:00.000Z', bis: '2026-10-30T11:00:00.000Z', eigene: false },
    { benutzer: 'bob', admin: false, adresse: '10.0.0.8', seit: '2026-10-30T10:01:00.000Z', zuletzt: '2026-10-30T10:01:00.000Z', bis: '2026-10-30T11:01:00.000Z', eigene: true },
  ]);
  assert.doesNotMatch(JSON.stringify(liste), new RegExp(`${tA}|${tB}`));
  zeit += 3_600_000;
  assert.deepEqual(a.liste(), [], 'abgelaufene Sitzungen erscheinen nicht');
});

async function testZertifikat() {
  const ordner = await mkdtemp(path.join(tmpdir(), 'mb-zert-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '30',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-keyout', path.join(ordner, 'k.pem'), '-out', path.join(ordner, 'c.pem')], { stdio: 'ignore' });
  const tls = { key: await readFile(path.join(ordner, 'k.pem'), 'utf8'), cert: await readFile(path.join(ordner, 'c.pem'), 'utf8') };
  await rm(ordner, { recursive: true, force: true });
  return tls;
}

function anfrage(port, ca, methode, weg, { kopf = {}, koerper } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', servername: 'localhost', port, method: methode, path: weg, ca, headers: { host: `localhost:${port}`, ...kopf } }, (res) => {
      let daten = '';
      res.on('data', (t) => { daten += t; });
      res.on('end', () => resolve({ status: res.statusCode, kopf: res.headers, text: daten, json: () => JSON.parse(daten) }));
    });
    req.on('error', reject);
    if (koerper) req.write(koerper);
    req.end();
  });
}

test('Webserver: Benutzer-API nur für Admins, eigenes Passwort für alle, Schutz vor fremden Seiten', async () => {
  const { ordner, anmeldung, bv, datei } = await aufbau();
  const tls = await testZertifikat();
  const module = { ansichten: () => [], finde: () => null };
  const server = await starteServer({ anwendung: erstelleAnwendung({ module, anmeldung, benutzerverwaltung: bv, sitzungMs: 60_000 }), tls, host: '127.0.0.1', port: 0 });
  const { port } = server.address();
  const ca = tls.cert;
  const login = async (name, pw) => {
    const r = await anfrage(port, ca, 'POST', '/login', { kopf: { 'content-type': 'application/x-www-form-urlencoded' }, koerper: `benutzer=${name}&passwort=${encodeURIComponent(pw)}` });
    return r.kopf['set-cookie']?.[0]?.split(';')[0] ?? null;
  };
  const post = (cookie, weg, wert, extra = {}) => anfrage(port, ca, 'POST', weg, { kopf: { cookie, 'x-monitor-anfrage': '1', 'content-type': 'application/json', ...extra }, koerper: JSON.stringify(wert) });
  try {
    const anna = await login('anna', PW);
    assert.ok(anna);
    let r = await anfrage(port, ca, 'GET', '/api/benutzer', { kopf: { cookie: anna } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json().benutzer, [{ name: 'anna', admin: true, sitzungen: 1 }]);
    assert.equal(r.json().sitzungen[0].eigene, true);
    assert.equal(r.json().sitzungen[0].adresse.replace(/^::ffff:/, ''), '127.0.0.1');

    r = await post(anna, '/api/benutzer', { name: 'bob', passwort: 'bob-passwort-1', admin: false });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json().benutzer.map((b) => b.name), ['anna', 'bob']);
    assert.doesNotMatch(r.text, /scrypt|hash/i, 'keine Hashes in der Antwort');
    r = await post(anna, '/api/benutzer', { name: 'bob', passwort: 'bob-passwort-1' });
    assert.deepEqual([r.status, r.json().fehler], [400, 'Den Benutzer „bob“ gibt es schon.']);
    assert.equal((await post(anna, '/api/benutzer', { name: 'carl', passwort: 'carl-passwort-1' }, { 'x-monitor-anfrage': '' })).status, 403, 'ohne eigenen Kopf abgelehnt');
    assert.equal((await post(anna, '/api/benutzer', { name: 'carl', passwort: 'carl-passwort-1' }, { origin: 'https://boese.example' })).status, 403, 'fremde Herkunft abgelehnt');

    // bob ist kein Admin: keine Benutzerverwaltung, aber eigenes Passwort ändern.
    const bob = await login('bob', 'bob-passwort-1');
    assert.equal((await anfrage(port, ca, 'GET', '/api/benutzer', { kopf: { cookie: bob } })).status, 403);
    assert.equal((await post(bob, '/api/benutzer', { name: 'x', passwort: 'x-passwort-123' })).status, 403);
    r = await post(bob, '/api/passwort', { alt: 'falsch-falsch', neu: 'bob-passwort-2' });
    assert.deepEqual([r.status, r.json().fehler], [400, 'Das bisherige Passwort stimmt nicht.']);
    assert.equal((await post(bob, '/api/passwort', { alt: 'bob-passwort-1', neu: 'bob-passwort-2' })).status, 200);
    assert.equal((await anfrage(port, ca, 'GET', '/api/status', { kopf: { cookie: bob } })).status, 200, 'eigene Sitzung bleibt');

    // Admin setzt bobs Passwort neu: bobs Sitzung endet.
    assert.equal((await post(anna, '/api/benutzer/bob/passwort', { passwort: 'bob-passwort-3' })).status, 200);
    assert.equal((await anfrage(port, ca, 'GET', '/api/status', { kopf: { cookie: bob } })).status, 401);
    const bob2 = await login('bob', 'bob-passwort-3');
    assert.ok(bob2);

    // Admin-Recht vergeben wirkt sofort; Fehler liefern die aktuelle Liste mit.
    assert.equal((await post(anna, '/api/benutzer/bob/admin', { admin: true })).status, 200);
    assert.equal((await anfrage(port, ca, 'GET', '/api/benutzer', { kopf: { cookie: bob2 } })).status, 200);
    r = await post(anna, '/api/benutzer/anna/admin', { admin: false });
    assert.equal(r.status, 400);
    assert.ok(Array.isArray(r.json().benutzer));
    assert.equal((await post(anna, '/api/benutzer/niemand/loeschen', {})).status, 404);
    assert.equal((await post(anna, '/api/benutzer/bob/loeschen', {})).status, 200);
    assert.equal((await anfrage(port, ca, 'GET', '/api/status', { kopf: { cookie: bob2 } })).status, 401, 'gelöscht: Sitzung endet');
    assert.deepEqual(Object.keys((await datei()).benutzer), ['anna']);
    assert.equal((await anfrage(port, ca, 'GET', '/api/benutzer/anna/passwort', { kopf: { cookie: anna } })).status, 404);
  } finally {
    server.close();
    await rm(ordner, { recursive: true, force: true });
  }
});
