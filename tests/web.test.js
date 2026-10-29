import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Anmeldung, hashPasswort, passwortStimmt } from '../basis/anmeldung.js';
import { erstelleAnwendung, starteServer } from '../basis/webserver.js';
import { brauchtErneuerung, CloudflareDns, Zertifikatsverwaltung } from '../basis/zertifikat.js';

async function testZertifikat(tage = 90, name = 'localhost') {
  const ordner = await mkdtemp(path.join(tmpdir(), 'mb-zert-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', String(tage),
    '-subj', `/CN=${name}`, '-addext', `subjectAltName=DNS:${name}`, '-keyout', path.join(ordner, 'k.pem'), '-out', path.join(ordner, 'c.pem')], { stdio: 'ignore' });
  const tls = { key: await readFile(path.join(ordner, 'k.pem'), 'utf8'), cert: await readFile(path.join(ordner, 'c.pem'), 'utf8') };
  await rm(ordner, { recursive: true, force: true });
  return tls;
}

function anfrage(port, ca, methode, weg, { kopf = {}, koerper } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', servername: 'localhost', port, method: methode, path: weg, ca, headers: { host: `localhost:${port}`, ...kopf } }, (res) => {
      let daten = '';
      res.on('data', (t) => { daten += t; });
      res.on('end', () => resolve({ status: res.statusCode, kopf: res.headers, text: daten }));
    });
    req.on('error', reject);
    if (koerper) req.write(koerper);
    req.end();
  });
}

test('Passwort-Hash: richtig, falsch, manipuliert, zu kurz', async () => {
  const hash = await hashPasswort('ein-langes-passwort');
  assert.equal(await passwortStimmt('ein-langes-passwort', hash), true);
  assert.equal(await passwortStimmt('falsch-falsch', hash), false);
  assert.equal(await passwortStimmt('x', 'kaputt'), false);
  await assert.rejects(hashPasswort('kurz'), /10 Zeichen/);
});

test('Anmeldung: Sitzung, Ablauf und Sperre nach Fehlversuchen', async () => {
  let zeit = 1_000_000;
  const a = new Anmeldung({ benutzer: { anna: { hash: await hashPasswort('geheim-geheim') } }, sitzungMs: 1000, jetzt: () => zeit, maxFehlversuche: 3 });
  const token = await a.anmelden('anna', 'geheim-geheim', 'ip1');
  assert.equal(a.sitzung(token).benutzer, 'anna');
  zeit += 1000;
  assert.equal(a.sitzung(token), null);
  assert.equal(await a.anmelden('anna', 'falsch', 'ip2'), null);
  assert.equal(await a.anmelden('niemand', 'falsch', 'ip2'), null);
  assert.equal(await a.anmelden('anna', 'falsch', 'ip2'), 'gesperrt');
  assert.equal(await a.anmelden('anna', 'geheim-geheim', 'ip2'), 'gesperrt');
  assert.equal(typeof await a.anmelden('anna', 'geheim-geheim', 'ip1'), 'string');
  assert.equal(await a.anmelden('constructor', 'x', 'ip3'), null);
});

test('Webserver: HTTPS, Login, geschützte API, manuelle Prüfung, Abmelden', async () => {
  const tls = await testZertifikat();
  const gestartet = [];
  const module = [
    { id: 'ftp', name: 'FTP', typ: 'programm', aktiv: true, intervallMinuten: 5 },
    { id: 'kaputt', name: 'kaputt', fehler: 'module.json: typ fehlt' },
  ];
  const planer = { laeuft: () => false, naechster: () => null, jetztPruefen: (id) => { gestartet.push(id); return gestartet.length < 2; } };
  const speicher = { letztes: (id) => ({ status: 'ok', zusammenfassung: `alles gut ${id}` }), verlauf: () => [{ status: 'ok' }] };
  const anmeldung = new Anmeldung({ benutzer: { anna: { hash: await hashPasswort('geheim-geheim') } }, sitzungMs: 60_000 });
  const server = await starteServer({ anwendung: erstelleAnwendung({ module, planer, speicher, anmeldung, sitzungMs: 60_000 }), tls, host: '127.0.0.1', port: 0 });
  const { port } = server.address();
  const ca = tls.cert;
  try {
    const start = await anfrage(port, ca, 'GET', '/');
    assert.equal(start.status, 303);
    assert.equal(start.kopf.location, '/login');
    assert.match(start.kopf['strict-transport-security'], /max-age/);
    assert.equal((await anfrage(port, ca, 'GET', '/api/status')).status, 401);
    assert.equal((await anfrage(port, ca, 'GET', '/style.css')).status, 200);

    const login = await anfrage(port, ca, 'GET', '/login?fehler=1');
    assert.match(login.text, /Passwort falsch/);
    assert.match(login.kopf['content-security-policy'], /script-src 'self'/);

    const form = { 'content-type': 'application/x-www-form-urlencoded' };
    const falsch = await anfrage(port, ca, 'POST', '/login', { kopf: form, koerper: 'benutzer=anna&passwort=nein' });
    assert.equal(falsch.kopf.location, '/login?fehler=1');
    const fremd = await anfrage(port, ca, 'POST', '/login', { kopf: { ...form, origin: 'https://boese.example' }, koerper: 'benutzer=anna&passwort=geheim-geheim' });
    assert.equal(fremd.status, 403);
    assert.equal(login.kopf['referrer-policy'], 'same-origin', 'no-referrer würde Origin: null erzeugen');
    const eigen = await anfrage(port, ca, 'POST', '/login', { kopf: { ...form, origin: `https://localhost:${port}` }, koerper: 'benutzer=anna&passwort=nein' });
    assert.equal(eigen.kopf.location, '/login?fehler=1');
    const ok = await anfrage(port, ca, 'POST', '/login', { kopf: form, koerper: 'benutzer=anna&passwort=geheim-geheim' });
    assert.equal(ok.kopf.location, '/');
    const cookie = ok.kopf['set-cookie'][0];
    assert.match(cookie, /HttpOnly; Secure; SameSite=Strict/);
    const sitzung = { cookie: cookie.split(';')[0] };

    assert.match((await anfrage(port, ca, 'GET', '/', { kopf: sitzung })).text, /<title>Monitoring/);
    const status = JSON.parse((await anfrage(port, ca, 'GET', '/api/status', { kopf: sitzung })).text);
    assert.equal(status.benutzer, 'anna');
    assert.equal(status.module[0].letztes.zusammenfassung, 'alles gut ftp');
    assert.equal(status.module[1].fehler, 'module.json: typ fehlt');
    assert.equal(status.module[1].letztes, null);
    assert.equal(status.module[0].befehl, undefined);

    assert.equal((await anfrage(port, ca, 'GET', '/api/module/ftp/verlauf?anzahl=5', { kopf: sitzung })).status, 200);
    assert.equal((await anfrage(port, ca, 'GET', '/api/module/gibtsnicht/verlauf', { kopf: sitzung })).status, 404);
    assert.equal((await anfrage(port, ca, 'POST', '/api/module/ftp/pruefen', { kopf: sitzung })).status, 403, 'ohne Schutzkopf');
    const pruef = { ...sitzung, 'x-monitor-anfrage': '1' };
    assert.equal((await anfrage(port, ca, 'POST', '/api/module/ftp/pruefen', { kopf: pruef })).status, 202);
    assert.equal((await anfrage(port, ca, 'POST', '/api/module/ftp/pruefen', { kopf: pruef })).status, 409, 'läuft bereits');
    assert.equal((await anfrage(port, ca, 'POST', '/api/module/kaputt/pruefen', { kopf: pruef })).status, 409);
    assert.deepEqual(gestartet, ['ftp', 'ftp']);

    const ab = await anfrage(port, ca, 'POST', '/logout', { kopf: sitzung });
    assert.equal(ab.kopf.location, '/login');
    assert.equal((await anfrage(port, ca, 'GET', '/api/status', { kopf: sitzung })).status, 401);
  } finally {
    server.close();
  }
});

test('Zertifikat: Erneuerung nötig bei kurzer Restlaufzeit oder falschem Namen', async () => {
  const lang = await testZertifikat(90, 'm.firma.de');
  const kurz = await testZertifikat(10, 'm.firma.de');
  assert.equal(brauchtErneuerung(lang.cert, 'm.firma.de'), false);
  assert.equal(brauchtErneuerung(lang.cert, 'anders.firma.de'), true);
  assert.equal(brauchtErneuerung(kurz.cert, 'm.firma.de'), true);
  assert.equal(brauchtErneuerung(null, 'm.firma.de'), true);
  assert.equal(brauchtErneuerung('kein pem', 'm.firma.de'), true);
});

test('Cloudflare: Zone über übergeordnete Domain finden, TXT anlegen und löschen, Fehler verständlich', async () => {
  const aufrufe = [];
  const fetchImpl = async (url, opt) => {
    aufrufe.push(`${opt.method} ${url.replace('https://api.cloudflare.com/client/v4', '')}`);
    assert.equal(opt.headers.Authorization, 'Bearer TOKEN');
    if (url.includes('zones?name=firma.de')) return Response.json({ success: true, result: [{ id: 'Z1' }] });
    if (url.includes('zones?name=')) return Response.json({ success: true, result: [] });
    if (opt.method === 'POST') { assert.deepEqual(JSON.parse(opt.body), { type: 'TXT', name: '_acme-challenge.m.firma.de', content: 'WERT', ttl: 60 }); return Response.json({ success: true, result: { id: 'R1' } }); }
    return Response.json({ success: true, result: {} });
  };
  const dns = new CloudflareDns('TOKEN', fetchImpl);
  const eintrag = await dns.txtAnlegen('_acme-challenge.m.firma.de', 'WERT');
  assert.deepEqual(eintrag, { zone: 'Z1', id: 'R1' });
  await dns.txtLoeschen(eintrag);
  assert.deepEqual(aufrufe, [
    'GET /zones?name=_acme-challenge.m.firma.de', 'GET /zones?name=m.firma.de', 'GET /zones?name=firma.de',
    'POST /zones/Z1/dns_records', 'DELETE /zones/Z1/dns_records/R1',
  ]);
  const abgelehnt = new CloudflareDns('T', async () => Response.json({ success: false, errors: [{ message: 'Invalid access token' }] }, { status: 403 }));
  await assert.rejects(abgelehnt.zoneFinden('m.firma.de'), /Invalid access token.*Token-Rechte/);
  const offline = new CloudflareDns('T', async () => { throw new Error('ENOTFOUND'); });
  await assert.rejects(offline.zoneFinden('m.firma.de'), /nicht erreichbar/);
});

test('Zertifikatsverwaltung: Ablauf mit Let\'s Encrypt (simuliert) und Wiederverwendung', async () => {
  const daten = await mkdtemp(path.join(tmpdir(), 'mb-le-'));
  const echt = await testZertifikat(90, 'm.firma.de');
  const schritte = [];
  const acmeImpl = {
    directory: { letsencrypt: { staging: 'STAGING', production: 'PROD' } },
    crypto: {
      createPrivateKey: async () => Buffer.from('KONTO'),
      createCsr: async ({ commonName }) => { schritte.push(`csr ${commonName}`); return [Buffer.from(echt.key), Buffer.from('CSR')]; },
    },
    Client: class {
      constructor(o) { schritte.push(`client ${o.directoryUrl} ${o.accountKey}`); }
      async auto(o) {
        assert.deepEqual(o.challengePriority, ['dns-01']);
        assert.equal(o.skipChallengeVerification, true);
        await o.challengeCreateFn({ identifier: { value: 'm.firma.de' } }, { type: 'dns-01' }, 'KA');
        await o.challengeRemoveFn({ identifier: { value: 'm.firma.de' } }, { type: 'dns-01' }, 'KA');
        return echt.cert;
      }
    },
  };
  const dns = { txtAnlegen: async (n, w) => { schritte.push(`txt+ ${n} ${w}`); return { zone: 'Z', id: 'R' }; }, txtLoeschen: async () => { schritte.push('txt-'); } };
  const konfig = { hostname: 'm.firma.de', datenOrdner: daten, tls: { modus: 'letsencrypt', email: 'it@firma.de', cloudflareToken: 'T', staging: true } };
  try {
    const verwaltung = new Zertifikatsverwaltung({ konfig, acmeImpl, dns, warten: async (n) => schritte.push(`warten ${n}`) });
    const erstes = await verwaltung.laden();
    assert.equal(erstes.cert, echt.cert);
    assert.deepEqual(schritte, ['client STAGING KONTO', 'csr m.firma.de', 'txt+ _acme-challenge.m.firma.de KA', 'warten _acme-challenge.m.firma.de', 'txt-']);
    schritte.length = 0;
    const zweites = await verwaltung.laden();
    assert.equal(zweites.key, echt.key);
    assert.deepEqual(schritte, [], 'gültiges Zertifikat wird wiederverwendet');

    // Bald ablaufendes, aber noch gültiges Zertifikat: Scheitert die Erneuerung, läuft die Basis damit weiter.
    const kurz = await testZertifikat(10, 'm.firma.de');
    await writeFile(path.join(daten, 'zertifikat', 'zertifikat.pem'), kurz.cert);
    await writeFile(path.join(daten, 'zertifikat', 'schluessel.pem'), kurz.key);
    const meldungen = [];
    const kaputt = new Zertifikatsverwaltung({ konfig, acmeImpl: { ...acmeImpl, Client: class { async auto() { throw new Error('rateLimited'); } } }, dns, warten: async () => {}, log: (t) => meldungen.push(t) });
    assert.equal((await kaputt.laden()).cert, kurz.cert);
    assert.match(meldungen.at(-1), /weiterverwendet/);
    await rm(path.join(daten, 'zertifikat', 'zertifikat.pem'));
    await assert.rejects(kaputt.laden(), /rateLimited/);
  } finally { await rm(daten, { recursive: true, force: true }); }
});
