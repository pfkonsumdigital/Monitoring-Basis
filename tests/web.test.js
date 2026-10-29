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
import { berechneAnsicht } from '../basis/modulansicht.js';

// Schlanke Modulverwaltung für Webserver-Tests (gleiche Schnittstelle wie basis/modulverwaltung.js).
function testModule(liste, planer, speicher) {
  return {
    ansichten: () => liste.map((m) => ({ ...berechneAnsicht(m, { verlauf: !m.fehler && speicher.letztes?.(m.id) ? [speicher.letztes(m.id)] : [], laeuft: planer.laeuft?.(m.id) ?? false }) })),
    finde: (id) => liste.find((m) => m.id === id) ?? null,
    verlauf: (id, n) => speicher.verlauf(id, n),
    jetztPruefen: (id) => { const m = liste.find((x) => x.id === id); return m.fehler ? 'fehlerhaft' : planer.jetztPruefen(id) ? 'gestartet' : 'laeuft'; },
  };
}

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
  const server = await starteServer({ anwendung: erstelleAnwendung({ module: testModule(module, planer, speicher), anmeldung, sitzungMs: 60_000 }), tls, host: '127.0.0.1', port: 0 });
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

test('Webserver: Updates nur für Admins und nur mit Schutzkopf', async () => {
  const tls = await testZertifikat();
  const aufrufe = [];
  const updates = {
    installiert: '0.2.0',
    status: () => ({ eingerichtet: true, installiert: '0.2.0', phase: 'bereit', updateMoeglich: true }),
    suchen: async () => { aufrufe.push('suchen'); return { phase: 'bereit' }; },
    installieren: async (v) => { aufrufe.push(`installieren ${v}`); return { phase: 'neustart' }; },
    zurueck: async () => { throw new Error('Es gibt keine vorherige Version.'); },
  };
  const benutzer = { chef: { hash: await hashPasswort('geheim-geheim'), admin: true }, gast: { hash: await hashPasswort('geheim-geheim') } };
  const anmeldung = new Anmeldung({ benutzer, sitzungMs: 60_000 });
  const planer = { laeuft: () => false, naechster: () => null };
  const speicher = { letztes: () => null };
  const server = await starteServer({ anwendung: erstelleAnwendung({ module: testModule([], planer, speicher), anmeldung, updates, sitzungMs: 60_000 }), tls, host: '127.0.0.1', port: 0 });
  const { port } = server.address();
  const ca = tls.cert;
  const form = { 'content-type': 'application/x-www-form-urlencoded' };
  const sitzung = async (name) => ({ cookie: (await anfrage(port, ca, 'POST', '/login', { kopf: form, koerper: `benutzer=${name}&passwort=geheim-geheim` })).kopf['set-cookie'][0].split(';')[0] });
  try {
    const gast = await sitzung('gast');
    const chef = await sitzung('chef');
    const gastStatus = JSON.parse((await anfrage(port, ca, 'GET', '/api/status', { kopf: gast })).text);
    assert.equal(gastStatus.admin, false);
    assert.equal(gastStatus.updateVerfuegbar, false);
    assert.equal(gastStatus.version, '0.2.0');
    assert.equal((await anfrage(port, ca, 'GET', '/api/updates', { kopf: gast })).status, 403);
    assert.equal((await anfrage(port, ca, 'POST', '/api/updates/suchen', { kopf: { ...gast, 'x-monitor-anfrage': '1' } })).status, 403);

    const chefStatus = JSON.parse((await anfrage(port, ca, 'GET', '/api/status', { kopf: chef })).text);
    assert.equal(chefStatus.admin, true);
    assert.equal(chefStatus.updateVerfuegbar, true);
    assert.equal((await anfrage(port, ca, 'GET', '/api/updates', { kopf: chef })).status, 200);
    assert.equal((await anfrage(port, ca, 'POST', '/api/updates/suchen', { kopf: chef })).status, 403, 'ohne Schutzkopf');
    const schutz = { ...chef, 'x-monitor-anfrage': '1' };
    assert.equal((await anfrage(port, ca, 'POST', '/api/updates/suchen', { kopf: schutz })).status, 200);
    assert.equal((await anfrage(port, ca, 'POST', '/api/updates/installieren', { kopf: schutz, koerper: '{"version":"0.3.0"}' })).status, 202);
    assert.equal((await anfrage(port, ca, 'POST', '/api/updates/installieren', { kopf: schutz, koerper: 'kaputt' })).status, 400);
    const zurueck = await anfrage(port, ca, 'POST', '/api/updates/zurueck', { kopf: schutz });
    assert.equal(zurueck.status, 409);
    assert.match(JSON.parse(zurueck.text).fehler, /keine vorherige/);
    assert.deepEqual(aufrufe, ['suchen', 'installieren 0.3.0']);
    assert.match((await anfrage(port, ca, 'GET', '/login?fehler=update')).text, /neu gestartet/);
  } finally {
    server.close();
  }
});

test('Webserver: Fehlerprotokoll und Neustart nur für Admins; 500er landen im Protokoll', async () => {
  const { Protokoll } = await import('../basis/protokoll.js');
  const { mkdtemp: mkd } = await import('node:fs/promises');
  const ordner = await mkd(path.join(tmpdir(), 'mb-webprot-'));
  const tls = await testZertifikat();
  const protokoll = new Protokoll({ ordner, konsole: false });
  protokoll.warnung('Modul ftp', 'zu alt');
  protokoll.fehler('Zertifikat', 'Erneuerung fehlgeschlagen', 'Details hier');
  let neugestartet = 0;
  const benutzer = { chef: { hash: await hashPasswort('geheim-geheim'), admin: true }, gast: { hash: await hashPasswort('geheim-geheim') } };
  const anmeldung = new Anmeldung({ benutzer, sitzungMs: 60_000 });
  const kaputt = { laeuft: () => { throw new Error('Planer kaputt'); }, naechster: () => null };
  const server = await starteServer({ anwendung: erstelleAnwendung({ module: { ansichten: () => kaputt.laeuft(), finde: () => null }, anmeldung, protokoll, neustart: () => { neugestartet++; }, sitzungMs: 60_000, log: protokoll.alsFunktion() }), tls, host: '127.0.0.1', port: 0 });
  const { port } = server.address();
  const ca = tls.cert;
  const form = { 'content-type': 'application/x-www-form-urlencoded' };
  const sitzung = async (name) => ({ cookie: (await anfrage(port, ca, 'POST', '/login', { kopf: form, koerper: `benutzer=${name}&passwort=geheim-geheim` })).kopf['set-cookie'][0].split(';')[0] });
  try {
    const gast = await sitzung('gast');
    const chef = await sitzung('chef');
    assert.equal((await anfrage(port, ca, 'GET', '/api/protokoll', { kopf: gast })).status, 403);
    assert.equal((await anfrage(port, ca, 'GET', '/api/protokoll/download', { kopf: gast })).status, 403);
    assert.equal((await anfrage(port, ca, 'POST', '/api/neustart', { kopf: { ...gast, 'x-monitor-anfrage': '1' } })).status, 403);

    // /api/status wirft hier absichtlich (Planer kaputt) → 500 und Eintrag im Fehlerprotokoll
    assert.equal((await anfrage(port, ca, 'GET', '/api/status', { kopf: chef })).status, 500);
    const daten = JSON.parse((await anfrage(port, ca, 'GET', '/api/protokoll', { kopf: chef })).text);
    assert.deepEqual(daten.eintraege.map((e) => e.quelle), ['Webserver', 'Zertifikat', 'Modul ftp']);
    assert.match(daten.eintraege[0].meldung, /Interner Fehler bei GET \/api\/status: Planer kaputt/);
    assert.deepEqual(daten.quellen, ['Modul', 'Webserver', 'Zertifikat']);
    const nurWarnung = JSON.parse((await anfrage(port, ca, 'GET', '/api/protokoll?stufe=warnung', { kopf: chef })).text);
    assert.deepEqual(nurWarnung.eintraege.map((e) => e.meldung), ['zu alt']);
    const download = await anfrage(port, ca, 'GET', '/api/protokoll/download?quelle=Zertifikat', { kopf: chef });
    assert.match(download.kopf['content-disposition'], /fehlerprotokoll\.txt/);
    assert.match(download.text, /\[FEHLER\] \[Zertifikat\] Erneuerung fehlgeschlagen\n    Details hier/);
    assert.doesNotMatch(download.text, /Modul ftp/);

    assert.equal((await anfrage(port, ca, 'POST', '/api/neustart', { kopf: chef })).status, 403, 'ohne Schutzkopf');
    assert.equal((await anfrage(port, ca, 'POST', '/api/neustart', { kopf: { ...chef, 'x-monitor-anfrage': '1' } })).status, 202);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(neugestartet, 1);
  } finally {
    server.close();
    await rm(ordner, { recursive: true, force: true });
  }
});

test('Interne Adressen erkennen', async () => {
  const { istInterneAdresse } = await import('../basis/webserver.js');
  for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.178.20', '169.254.1.1', '::1', '::ffff:192.168.1.5', 'fd12:3456::1', 'fe80::1'])
    assert.equal(istInterneAdresse(a), true, a);
  for (const a of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '192.169.0.1', '::ffff:8.8.8.8', '2001:db8::1', '', undefined, 'fe80', '11.0.0.1'])
    assert.equal(istInterneAdresse(a), false, String(a));
});

test('Webserver ohne Verschlüsselung: HTTP-Login, Cookie ohne Secure, kein HSTS, nur internes Netz', async () => {
  const http = await import('node:http');
  const meldungen = [];
  const log = Object.assign((m) => meldungen.push(['info', m]), { warnung: (q, m) => meldungen.push(['warnung', m]), fehler: (q, m) => meldungen.push(['fehler', m]) });
  const anmeldung = new Anmeldung({ benutzer: { anna: { hash: await hashPasswort('geheim-geheim') } }, sitzungMs: 60_000 });
  const planer = { laeuft: () => false, naechster: () => null };
  const anwendung = erstelleAnwendung({ module: testModule([], planer, { letztes: () => null }), anmeldung, sitzungMs: 60_000, verschluesselt: false, nurIntern: true, log });
  const server = await starteServer({ anwendung, tls: null, host: '127.0.0.1', port: 0 });
  const { port } = server.address();
  const hole = (methode, weg, kopf = {}, koerper) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: methode, path: weg, headers: { host: `192.168.1.10:${port}`, ...kopf } }, (res) => {
      let daten = ''; res.on('data', (t) => { daten += t; }); res.on('end', () => resolve({ status: res.statusCode, kopf: res.headers, text: daten }));
    });
    req.on('error', reject); if (koerper) req.write(koerper); req.end();
  });
  try {
    const start = await hole('GET', '/');
    assert.equal(start.status, 303);
    assert.equal(start.kopf['strict-transport-security'], undefined);
    const form = { 'content-type': 'application/x-www-form-urlencoded' };
    assert.equal((await hole('POST', '/login', { ...form, origin: `https://192.168.1.10:${port}` }, 'benutzer=anna&passwort=geheim-geheim')).status, 403);
    const ok = await hole('POST', '/login', { ...form, origin: `http://192.168.1.10:${port}` }, 'benutzer=anna&passwort=geheim-geheim');
    assert.equal(ok.kopf.location, '/');
    const cookie = ok.kopf['set-cookie'][0];
    assert.match(cookie, /HttpOnly; SameSite=Strict/);
    assert.doesNotMatch(cookie, /Secure/);
    const status = await hole('GET', '/api/status', { cookie: cookie.split(';')[0] });
    assert.equal(JSON.parse(status.text).benutzer, 'anna');
  } finally {
    server.close();
  }

  // Externe Adresse: abgewiesen und einmalig gemeldet.
  const antwort = () => {
    const r = { kopf: {}, status: 0, text: '', setHeader(n, w) { this.kopf[n] = w; }, writeHead(s, k) { this.status = s; Object.assign(this.kopf, k); }, end(t) { this.text = String(t ?? ''); }, headersSent: false };
    return r;
  };
  for (let i = 0; i < 2; i++) {
    const res = antwort();
    await anwendung({ method: 'GET', url: '/login', headers: {}, socket: { remoteAddress: '::ffff:8.8.8.8' } }, res);
    assert.equal(res.status, 403);
    assert.match(res.text, /internen Netz/);
  }
  assert.equal(meldungen.filter(([s, m]) => s === 'warnung' && m.includes('8.8.8.8')).length, 1);
});

test('Webserver: Moduleinstellungen und Pause nur für Admins, Passwörter verborgen, eigenständige Module nicht startbar', async () => {
  const http = await import('node:http');
  const { Modulverwaltung } = await import('../basis/modulverwaltung.js');
  const { Ergebnisspeicher } = await import('../basis/speicher.js');
  const { Planer } = await import('../basis/planer.js');
  const wurzel = await mkdtemp(path.join(tmpdir(), 'mb-webmod-'));
  const ordner = path.join(wurzel, 'modules', 'ftp');
  await (await import('node:fs/promises')).mkdir(ordner, { recursive: true });
  await writeFile(path.join(ordner, 'module.json'), JSON.stringify({ id: 'ftp', name: 'FTP', typ: 'eigenstaendig', intervall_minuten: 5, einstellungsfelder: [
    { schluessel: 'server', bezeichnung: 'Server', typ: 'text', pflicht: true },
    { schluessel: 'passwort', bezeichnung: 'Passwort', typ: 'passwort' },
  ] }));
  const speicher = new Ergebnisspeicher(path.join(wurzel, 'data'), 50);
  const planer = new Planer({ ausfuehren: async () => ({}), speichern: async () => {} });
  const module = new Modulverwaltung({ moduleOrdner: path.join(wurzel, 'modules'), datenOrdner: path.join(wurzel, 'data'), speicher, planer, uebernehmen: (id, e) => speicher.hinzufuegen(id, e) });
  await module.start();
  module.stop();
  const anmeldung = new Anmeldung({ benutzer: { chef: { hash: await hashPasswort('geheim-geheim'), admin: true }, gast: { hash: await hashPasswort('geheim-geheim') } }, sitzungMs: 60_000 });
  const server = await starteServer({ anwendung: erstelleAnwendung({ module, anmeldung, sitzungMs: 60_000, verschluesselt: false }), tls: null, host: '127.0.0.1', port: 0 });
  const { port } = server.address();
  const hole = (methode, weg, kopf = {}, koerper) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: methode, path: weg, headers: { host: `127.0.0.1:${port}`, ...kopf } }, (res) => {
      let daten = ''; res.on('data', (t) => { daten += t; }); res.on('end', () => resolve({ status: res.statusCode, text: daten, json: () => JSON.parse(daten) }));
    });
    req.on('error', reject); if (koerper) req.write(koerper); req.end();
  });
  const anmelden = async (name) => {
    const r = await new Promise((resolve) => http.request({ host: '127.0.0.1', port, method: 'POST', path: '/login', headers: { 'content-type': 'application/x-www-form-urlencoded' } }, resolve).end(`benutzer=${name}&passwort=geheim-geheim`));
    return { cookie: r.headers['set-cookie'][0].split(';')[0] };
  };
  try {
    const chef = await anmelden('chef');
    const gast = await anmelden('gast');
    const schutz = { 'x-monitor-anfrage': '1', 'content-type': 'application/json' };
    const status = (await hole('GET', '/api/status', gast)).json();
    assert.equal(status.module[0].anzeige, 'unbekannt');
    assert.equal(status.module[0].betriebsart, 'eigenstaendig');
    assert.equal(status.module[0].ordner, undefined, 'keine Pfade an die Oberfläche');

    assert.equal((await hole('GET', '/api/module/ftp/einstellungen', gast)).status, 403);
    assert.equal((await hole('POST', '/api/module/ftp/aktiv', { ...gast, ...schutz }, '{"aktiv":false}')).status, 403);
    assert.equal((await hole('POST', '/api/module/ftp/einstellungen', chef, '{"werte":{}}')).status, 403, 'ohne Schutzkopf');
    assert.equal((await hole('POST', '/api/module/ftp/pruefen', { ...gast, ...schutz })).status, 409, 'eigenständig');

    const fehlt = await hole('POST', '/api/module/ftp/einstellungen', { ...chef, ...schutz }, '{"werte":{"passwort":"Ganz-Geheim-9"}}');
    assert.equal(fehlt.status, 400);
    assert.deepEqual(fehlt.json().feldfehler, { server: 'Pflichtfeld' });
    const ok = await hole('POST', '/api/module/ftp/einstellungen', { ...chef, ...schutz }, '{"werte":{"server":"ftp.firma.de","passwort":"Ganz-Geheim-9"}}');
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json().werte, { server: 'ftp.firma.de', passwort: { gesetzt: true } });
    const lesen = await hole('GET', '/api/module/ftp/einstellungen', chef);
    assert.doesNotMatch(lesen.text, /Ganz-Geheim-9/);
    assert.equal(lesen.json().felder.length, 2);

    assert.equal((await hole('POST', '/api/module/ftp/aktiv', { ...chef, ...schutz }, '{"aktiv":"nein"}')).status, 400);
    assert.equal((await hole('POST', '/api/module/ftp/aktiv', { ...chef, ...schutz }, '{"aktiv":false}')).status, 200);
    assert.equal((await hole('GET', '/api/status', chef)).json().module[0].anzeige, 'inaktiv');
    assert.equal((await hole('GET', '/api/module/gibtsnicht/einstellungen', chef)).status, 404);
  } finally {
    server.close();
    await rm(wurzel, { recursive: true, force: true });
  }
});

test('Webserver: Benachrichtigung nur für Admins, Schlüssel nie zurück, Testmail', async () => {
  const http = await import('node:http');
  const { Benachrichtigung } = await import('../basis/benachrichtigung.js');
  const wurzel = await mkdtemp(path.join(tmpdir(), 'mb-webben-'));
  const gesendet = [];
  const fetchImpl = async (url, opt) => {
    if (url.includes('token')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
    gesendet.push(JSON.parse(opt.body).message.subject);
    return new Response(null, { status: 202 });
  };
  const benachrichtigung = new Benachrichtigung({ datenOrdner: wurzel, fetchImpl });
  await benachrichtigung.laden();
  const anmeldung = new Anmeldung({ benutzer: { chef: { hash: await hashPasswort('geheim-geheim'), admin: true }, gast: { hash: await hashPasswort('geheim-geheim') } }, sitzungMs: 60_000 });
  const server = await starteServer({ anwendung: erstelleAnwendung({ module: testModule([], {}, {}), benachrichtigung, anmeldung, sitzungMs: 60_000, verschluesselt: false }), tls: null, host: '127.0.0.1', port: 0 });
  const { port } = server.address();
  const hole = (methode, weg, kopf = {}, koerper) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: methode, path: weg, headers: { host: `127.0.0.1:${port}`, ...kopf } }, (res) => {
      let daten = ''; res.on('data', (t) => { daten += t; }); res.on('end', () => resolve({ status: res.statusCode, text: daten, json: () => JSON.parse(daten) }));
    });
    req.on('error', reject); if (koerper) req.write(koerper); req.end();
  });
  const anmelden = async (name) => {
    const r = await new Promise((resolve) => http.request({ host: '127.0.0.1', port, method: 'POST', path: '/login', headers: { 'content-type': 'application/x-www-form-urlencoded' } }, resolve).end(`benutzer=${name}&passwort=geheim-geheim`));
    return { cookie: r.headers['set-cookie'][0].split(';')[0] };
  };
  try {
    const chef = await anmelden('chef');
    const gast = await anmelden('gast');
    const schutz = { 'x-monitor-anfrage': '1', 'content-type': 'application/json' };
    assert.equal((await hole('GET', '/api/benachrichtigung', gast)).status, 403);
    assert.equal((await hole('POST', '/api/benachrichtigung', chef, '{}')).status, 403, 'ohne Schutzkopf');
    assert.equal((await hole('POST', '/api/benachrichtigung/test', { ...chef, ...schutz })).status, 409, 'noch nicht eingerichtet');
    const falsch = await hole('POST', '/api/benachrichtigung', { ...chef, ...schutz }, JSON.stringify({ werte: { aktiv: true } }));
    assert.equal(falsch.status, 400);
    assert.ok(falsch.json().feldfehler.tenant_id);
    const ok = await hole('POST', '/api/benachrichtigung', { ...chef, ...schutz }, JSON.stringify({ werte: { aktiv: true, tenant_id: 'firma.onmicrosoft.com', client_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', client_secret: 'Ganz~Geheim~42', absender: 'monitoring@firma.de', empfaenger: 'it@firma.de' } }));
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json().werte.client_secret, { gesetzt: true });
    assert.doesNotMatch(ok.text + (await hole('GET', '/api/benachrichtigung', chef)).text, /Ganz~Geheim/);
    const test = await hole('POST', '/api/benachrichtigung/test', { ...chef, ...schutz });
    assert.equal(test.status, 200);
    assert.deepEqual(gesendet, ['[Monitoring] Testmail']);
    assert.equal(test.json().verlauf[0].art, 'test');
  } finally {
    server.close();
    await rm(wurzel, { recursive: true, force: true });
  }
});

test('Webserver: GitHub-Token speichern, prüfen, entfernen nur für Admins mit Schutzkopf', async () => {
  const http = await import('node:http');
  const aufrufe = [];
  const updates = {
    status: () => ({ eingerichtet: true, token: { gesetzt: true, quelle: 'oberflaeche' } }),
    tokenSpeichern: async (t, b) => { aufrufe.push(['speichern', t, b]); if (t === 'falsch') throw new Error('GitHub hat den Token abgelehnt'); return { token: { quelle: 'oberflaeche' } }; },
    tokenTesten: async () => { aufrufe.push(['testen']); return { token: { ok: true } }; },
    tokenEntfernen: async (b) => { aufrufe.push(['entfernen', b]); return { token: { quelle: null } }; },
  };
  const anmeldung = new Anmeldung({ benutzer: { chef: { hash: await hashPasswort('geheim-geheim'), admin: true }, gast: { hash: await hashPasswort('geheim-geheim') } }, sitzungMs: 60_000 });
  const server = await starteServer({ anwendung: erstelleAnwendung({ module: testModule([], {}, {}), updates, anmeldung, sitzungMs: 60_000, verschluesselt: false }), tls: null, host: '127.0.0.1', port: 0 });
  const { port } = server.address();
  const hole = (weg, kopf = {}, koerper) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: weg, headers: { host: `127.0.0.1:${port}`, ...kopf } }, (res) => {
      let daten = ''; res.on('data', (t) => { daten += t; }); res.on('end', () => resolve({ status: res.statusCode, json: () => JSON.parse(daten) }));
    });
    req.on('error', reject); if (koerper) req.write(koerper); req.end();
  });
  const anmelden = async (name) => {
    const r = await new Promise((resolve) => http.request({ host: '127.0.0.1', port, method: 'POST', path: '/login', headers: { 'content-type': 'application/x-www-form-urlencoded' } }, resolve).end(`benutzer=${name}&passwort=geheim-geheim`));
    return { cookie: r.headers['set-cookie'][0].split(';')[0] };
  };
  try {
    const chef = await anmelden('chef');
    const gast = await anmelden('gast');
    const schutz = { 'x-monitor-anfrage': '1', 'content-type': 'application/json' };
    assert.equal((await hole('/api/updates/token', { ...gast, ...schutz }, '{"token":"x"}')).status, 403);
    assert.equal((await hole('/api/updates/token', chef, '{"token":"x"}')).status, 403, 'ohne Schutzkopf');
    const falsch = await hole('/api/updates/token', { ...chef, ...schutz }, '{"token":"falsch"}');
    assert.equal(falsch.status, 400);
    assert.match(falsch.json().fehler, /abgelehnt/);
    assert.equal((await hole('/api/updates/token', { ...chef, ...schutz }, '{"token":"github_pat_x"}')).status, 200);
    assert.equal((await hole('/api/updates/token/pruefen', { ...chef, ...schutz })).status, 200);
    assert.equal((await hole('/api/updates/token', { ...chef, ...schutz }, '{"entfernen":true}')).status, 200);
    assert.deepEqual(aufrufe.map((a) => a[0]), ['speichern', 'speichern', 'testen', 'entfernen']);
    assert.equal(aufrufe[1][2], 'chef');
  } finally {
    server.close();
  }
});

test('Webserver: Basis und Module beenden nur für Admins mit Schutzkopf', async () => {
  const http = await import('node:http');
  const aufrufe = [];
  const module = {
    ansichten: () => [],
    finde: (id) => ({ ftp: { id: 'ftp' }, kaputt: { id: 'kaputt', fehler: 'module.json: x' } })[id] ?? null,
    beenden: async (id, benutzer) => { aufrufe.push(['modul-beenden', id, benutzer]); return { ok: true, text: 'beendet' }; },
    starten: async (id, benutzer) => { aufrufe.push(['modul-starten', id, benutzer]); return { fehler: 'Keine Berechtigung.' }; },
  };
  const beenden = (wunsch) => aufrufe.push(['basis-beenden', wunsch]);
  const anmeldung = new Anmeldung({ benutzer: { chef: { hash: await hashPasswort('geheim-geheim'), admin: true }, gast: { hash: await hashPasswort('geheim-geheim') } }, sitzungMs: 60_000 });
  const starte = (opt) => starteServer({ anwendung: erstelleAnwendung({ module, anmeldung, sitzungMs: 60_000, verschluesselt: false, ...opt }), tls: null, host: '127.0.0.1', port: 0 });
  const server = await starte({ beenden });
  const ohne = await starte({});
  const hole = (srv, methode, weg, kopf = {}, koerper) => new Promise((resolve, reject) => {
    const { port } = srv.address();
    const req = http.request({ host: '127.0.0.1', port, method: methode, path: weg, headers: { host: `127.0.0.1:${port}`, ...kopf } }, (res) => {
      let daten = ''; res.on('data', (t) => { daten += t; }); res.on('end', () => resolve({ status: res.statusCode, json: () => JSON.parse(daten) }));
    });
    req.on('error', reject); if (koerper) req.write(koerper); req.end();
  });
  const anmelden = async (srv, name) => {
    const r = await new Promise((resolve) => http.request({ host: '127.0.0.1', port: srv.address().port, method: 'POST', path: '/login', headers: { 'content-type': 'application/x-www-form-urlencoded' } }, resolve).end(`benutzer=${name}&passwort=geheim-geheim`));
    return { cookie: r.headers['set-cookie'][0].split(';')[0] };
  };
  try {
    const chef = await anmelden(server, 'chef');
    const gast = await anmelden(server, 'gast');
    const schutz = { 'x-monitor-anfrage': '1', 'content-type': 'application/json' };
    assert.equal((await hole(server, 'GET', '/api/status', chef)).json().beendenMoeglich, true);
    assert.equal((await hole(server, 'GET', '/api/status', gast)).json().beendenMoeglich, false);

    assert.equal((await hole(server, 'POST', '/api/beenden', { ...gast, ...schutz }, '{}')).status, 403);
    assert.equal((await hole(server, 'POST', '/api/beenden', chef, '{}')).status, 403, 'ohne Schutzkopf');
    assert.equal((await hole(server, 'POST', '/api/beenden', { ...chef, ...schutz, origin: 'http://boese.example' }, '{}')).status, 403, 'fremde Herkunft');
    assert.equal((await hole(server, 'GET', '/api/beenden', chef)).status, 404);
    assert.equal((await hole(server, 'POST', '/api/module/ftp/beenden', { ...gast, ...schutz })).status, 403);
    assert.equal((await hole(server, 'POST', '/api/module/ftp/starten', chef)).status, 403, 'ohne Schutzkopf');
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(aufrufe, [], 'nichts ausgelöst');

    const r1 = await hole(server, 'POST', '/api/module/ftp/beenden', { ...chef, ...schutz });
    assert.deepEqual([r1.status, r1.json()], [200, { ok: true, text: 'beendet' }]);
    const r2 = await hole(server, 'POST', '/api/module/ftp/starten', { ...chef, ...schutz });
    assert.deepEqual([r2.status, r2.json()], [409, { fehler: 'Keine Berechtigung.' }]);
    assert.equal((await hole(server, 'POST', '/api/module/kaputt/beenden', { ...chef, ...schutz })).status, 409);
    assert.equal((await hole(server, 'POST', '/api/module/gibtsnicht/beenden', { ...chef, ...schutz })).status, 404);

    assert.equal((await hole(server, 'POST', '/api/beenden', { ...chef, ...schutz }, '{"module":true}')).status, 202);
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(aufrufe, [['modul-beenden', 'ftp', 'chef'], ['modul-starten', 'ftp', 'chef'], ['basis-beenden', { benutzer: 'chef', mitModulen: true }]]);

    const chef2 = await anmelden(ohne, 'chef');
    assert.equal((await hole(ohne, 'GET', '/api/status', chef2)).json().beendenMoeglich, false);
    assert.equal((await hole(ohne, 'POST', '/api/beenden', { ...chef2, ...schutz }, '{}')).status, 409);
  } finally {
    server.close();
    ohne.close();
  }
});
