import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Anmeldung, hashPasswort } from '../basis/anmeldung.js';
import { Benutzerverwaltung } from '../basis/benutzerverwaltung.js';
import { Domainverwaltung, HTTPS_PORT, portFrei, zertifikatInfo } from '../basis/domain.js';
import { BasisFehler } from '../basis/fehler.js';
import { Tresor } from '../basis/geheimnis.js';
import { pruefeKonfiguration } from '../basis/konfiguration.js';
import { erstelleAnwendung, starteServer } from '../basis/webserver.js';

const DOMAIN = 'monitoring.konsum-weimar.de';
const TOKEN = 'hetzner-token-ABCDEF-123456';

async function zertifikat({ tage = 90, name = DOMAIN, aussteller = 'R11' } = {}) {
  const ordner = await mkdtemp(path.join(tmpdir(), 'mb-dz-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', String(tage),
    '-subj', `/O=${aussteller}/CN=${name}`, '-addext', `subjectAltName=DNS:${name}`, '-keyout', path.join(ordner, 'k.pem'), '-out', path.join(ordner, 'c.pem')], { stdio: 'ignore' });
  const z = { key: await readFile(path.join(ordner, 'k.pem'), 'utf8'), cert: await readFile(path.join(ordner, 'c.pem'), 'utf8') };
  await rm(ordner, { recursive: true, force: true });
  return z;
}

// Let's Encrypt (simuliert): liefert je nach Umgebung ein Test- oder echtes Zertifikat.
function acmeFake({ test, echt, fehler = null, schritte = [] }) {
  return {
    directory: { letsencrypt: { staging: 'STAGING', production: 'PROD' } },
    crypto: { createPrivateKey: async () => Buffer.from('KONTO'), createCsr: async ({ commonName }) => [Buffer.from((commonName === DOMAIN ? echt : test).key), Buffer.from('CSR')] },
    Client: class {
      constructor(o) { this.url = o.directoryUrl; schritte.push(`client ${o.directoryUrl}`); }
      async auto(o) {
        if (fehler) throw new Error(fehler);
        schritte.push(`email ${o.email}`);
        await o.challengeCreateFn({ identifier: { value: DOMAIN } }, { type: 'dns-01' }, 'KA');
        await o.challengeRemoveFn({ identifier: { value: DOMAIN } }, { type: 'dns-01' }, 'KA');
        return (this.url === 'STAGING' ? test : echt).cert;
      }
    },
  };
}

const fakeDpapi = () => async (aktion, eintraege) => eintraege.map(({ d, e }) => (aktion === 'schuetzen' ? Buffer.from(JSON.stringify({ d, e })).toString('base64') : JSON.parse(Buffer.from(d, 'base64').toString()).d));

async function aufbau({ konfig = {}, roh = {}, acme, mitTresor = true, aufloesen, neustart = () => {}, portPruefen = async () => true } = {}) {
  const ordner = await mkdtemp(path.join(tmpdir(), 'mb-domain-'));
  const datenOrdner = path.join(ordner, 'data');
  const configDatei = path.join(ordner, 'config.json');
  await writeFile(configDatei, JSON.stringify({ port: 8080, tls: { modus: 'aus' }, benutzer: { anna: { hash: 'h', admin: true } }, ...roh }, null, 2));
  const anmeldung = new Anmeldung({ benutzer: {}, sitzungMs: 60_000 });
  const tresor = mitTresor ? new Tresor({ datenOrdner, dpapi: fakeDpapi() }) : null;
  const log = [];
  const bv = new Benutzerverwaltung({ configDatei, anmeldung, tresor });
  const dnsAufrufe = [];
  const dnsFabrik = (anbieter, token) => ({
    zoneFinden: async (name) => { dnsAufrufe.push(`zone ${anbieter} ${token} ${name}`); if (token !== TOKEN) throw new BasisFehler('Hetzner-API: Token ungültig.'); return { zone: 'konsum-weimar.de', eintrag: 'monitoring' }; },
    txtAnlegen: async (name) => { dnsAufrufe.push(`txt+ ${anbieter} ${token} ${name}`); return { zone: 'konsum-weimar.de', eintrag: '_acme-challenge.monitoring', wert: 'KA' }; },
    txtLoeschen: async () => { dnsAufrufe.push('txt-'); },
  });
  const neustarts = [];
  const d = new Domainverwaltung({
    configDatei, konfig: { port: 8080, host: '0.0.0.0', hostname: null, datenOrdner, tls: { modus: 'aus' }, ...konfig }, tresor, benutzerverwaltung: bv,
    neustart: neustart && (() => { neustarts.push(1); neustart(); }), log: (m) => log.push(m), dnsFabrik, warten: async () => {}, acmeImpl: acme,
    aufloesen: aufloesen ?? (async () => [{ address: '192.168.100.20' }]), adressen: () => ['127.0.0.1', '192.168.100.20', '::1'], portPruefen,
  });
  const datei = async () => JSON.parse(await readFile(configDatei, 'utf8'));
  return { ordner, datenOrdner, configDatei, d, log, datei, dnsAufrufe, neustarts, tresor };
}

test('Domain: speichern (Token verschlüsselt, nie herausgegeben), Pflichtfelder, prüfen', async () => {
  const { ordner, d, datei, log, dnsAufrufe, tresor } = await aufbau();
  try {
    let st = await d.status();
    assert.deepEqual([st.modus, st.port, st.hostname, st.tokenGesetzt, st.umschaltenMoeglich, st.zertifikat], ['aus', 8080, '', false, false, null]);
    assert.match(st.umschaltenGrund, /Zuerst Domain, E-Mail und Token speichern/);
    await assert.rejects(d.pruefen(), /Zuerst Domain/);

    assert.deepEqual((await d.speichern({ hostname: 'monitoring', email: 'x', dns_anbieter: 'ionos', token: 'kurz' }, 'anna')).feldfehler, {
      hostname: 'Bitte einen vollständigen Namen wie monitoring.firma.de eintragen.',
      email: 'Bitte eine E-Mail-Adresse eintragen (Let\'s Encrypt meldet sich dort vor Ablauf).',
      dns_anbieter: 'Hetzner oder Cloudflare wählen.',
      token: 'Das sieht nicht wie ein API-Token aus.',
    });
    assert.deepEqual((await d.speichern({ hostname: DOMAIN, email: 'it@konsum-weimar.de', dns_anbieter: 'hetzner', token: '' }, 'anna')).feldfehler, { token: 'Bitte den API-Token von Hetzner eintragen.' });

    const r = await d.speichern({ hostname: ` ${DOMAIN.toUpperCase()} `, email: 'it@konsum-weimar.de', dns_anbieter: 'hetzner', token: TOKEN }, 'anna');
    assert.equal(r.geaendert, true);
    assert.doesNotMatch(JSON.stringify(r), new RegExp(TOKEN), 'Token nie in der Antwort');
    let roh = await datei();
    assert.equal(roh.hostname, DOMAIN);
    assert.deepEqual({ ...roh.tls, hetzner_token: undefined }, { modus: 'aus', email: 'it@konsum-weimar.de', dns_anbieter: 'hetzner', hetzner_token: undefined });
    assert.match(roh.tls.hetzner_token, /^dpapi:v1:/, 'verschlüsselt gespeichert');
    assert.equal(await tresor.einzeln(roh.tls.hetzner_token), TOKEN);
    assert.ok(pruefeKonfiguration(roh, ordner), 'config.json bleibt gültig (HTTP)');
    assert.ok(log.some((z) => /HTTPS-Einstellungen geändert durch anna: Domain monitoring\.konsum-weimar\.de, DNS-Anbieter Hetzner, neuer Token/.test(z)));
    assert.doesNotMatch(log.join('\n'), new RegExp(TOKEN));

    // Ohne neuen Token bleibt der gespeicherte; nichts geändert → kein Protokolleintrag.
    const anzahl = log.length;
    assert.equal((await d.speichern({ hostname: DOMAIN, email: 'it@konsum-weimar.de', dns_anbieter: 'hetzner', token: '' }, 'anna')).geaendert, false);
    assert.equal(log.length, anzahl);
    roh = await datei();
    assert.match(roh.tls.hetzner_token, /^dpapi:v1:/);

    st = await d.status();
    assert.deepEqual([st.hostname, st.email, st.dnsAnbieter, st.tokenGesetzt, st.adresse], [DOMAIN, 'it@konsum-weimar.de', 'hetzner', true, `https://${DOMAIN}:${HTTPS_PORT}/`]);
    assert.match(st.umschaltenGrund, /echte Zertifikat anfragen/);

    // Prüfen: Zone mit dem entschlüsselten Token, Auflösung zeigt auf diesen Rechner.
    const p = await d.pruefen();
    assert.equal(dnsAufrufe[0], `zone hetzner ${TOKEN} ${DOMAIN}`);
    assert.deepEqual([p.zone.ok, p.aufloesung.ok], [true, true]);
    assert.match(p.zone.text, /Zone konsum-weimar\.de bei Hetzner gefunden/);
    assert.match(p.aufloesung.text, /zeigt auf 192\.168\.100\.20 – das ist dieser Rechner/);
    assert.deepEqual((await d.status()).pruefung, p);
  } finally { await rm(ordner, { recursive: true, force: true }); }
});

test('Domain: prüfen mit falschem Token, fremder oder fehlender Adresse', async () => {
  const fremd = await aufbau({ roh: { hostname: DOMAIN, tls: { modus: 'aus', email: 'a@b.de', dns_anbieter: 'hetzner', hetzner_token: 'falscher-token-1234' } }, aufloesen: async () => [{ address: '203.0.113.7' }] });
  const fehlt = await aufbau({ roh: { hostname: DOMAIN, tls: { modus: 'aus', email: 'a@b.de', dns_anbieter: 'hetzner', hetzner_token: TOKEN } }, aufloesen: async () => { throw new Error('ENOTFOUND'); } });
  try {
    const p = await fremd.d.pruefen();
    assert.deepEqual([p.zone.ok, p.aufloesung.ok], [false, false]);
    assert.match(p.zone.text, /Token ungültig/);
    assert.match(p.aufloesung.text, /zeigt auf 203\.0\.113\.7 – das ist nicht dieser Rechner \(192\.168\.100\.20\)\. .*A-Record/);
    const q = await fehlt.d.pruefen();
    assert.equal(q.zone.ok, true, 'Klartext-Token (von Hand eingetragen) funktioniert auch');
    assert.match(q.aufloesung.text, /lässt sich von hier aus nicht auflösen.*Securepoint/);
  } finally {
    await rm(fremd.ordner, { recursive: true, force: true });
    await rm(fehlt.ordner, { recursive: true, force: true });
  }
});

test('Domain: Test- und echtes Zertifikat anfragen, umschalten auf HTTPS, zurück auf HTTP', async () => {
  const testZ = await zertifikat({ aussteller: '(STAGING) Lets Encrypt' });
  const echtZ = await zertifikat({ aussteller: 'Lets Encrypt' });
  const schritte = [];
  const ports = [];
  const { ordner, d, datei, dnsAufrufe, neustarts, log } = await aufbau({
    roh: { hostname: DOMAIN, tls: { modus: 'aus', email: 'it@konsum-weimar.de', dns_anbieter: 'hetzner', hetzner_token: TOKEN, staging: true } },
    acme: acmeFake({ test: testZ, echt: echtZ, schritte }), portPruefen: async (port) => { ports.push(port); return true; },
  });
  try {
    // Testzertifikat: läuft im Hintergrund, landet in zertifikat-test, ändert nichts am Betrieb.
    let st = await d.anfragen(true, 'anna');
    assert.equal(st.vorgang.art, 'test');
    await assert.rejects(d.anfragen(false, 'anna'), /läuft bereits/);
    await d.laufend;
    st = await d.status();
    assert.deepEqual([st.vorgang.laeuft, st.vorgang.ok, st.vorgang.fehler], [false, true, null]);
    assert.deepEqual([st.testzertifikat.domain, st.testzertifikat.test, st.testzertifikat.gueltig], [DOMAIN, true, true]);
    assert.equal(st.zertifikat, null, 'Betriebszertifikat unberührt');
    assert.deepEqual(schritte.slice(0, 2), ['client STAGING', 'email it@konsum-weimar.de']);
    assert.ok(dnsAufrufe.includes(`txt+ hetzner ${TOKEN} _acme-challenge.${DOMAIN}`) && dnsAufrufe.includes('txt-'));
    assert.match(st.umschaltenGrund, /echte Zertifikat/);
    await assert.rejects(d.umschalten('anna'), /echte Zertifikat/);

    // Echtes Zertifikat → Umschalten möglich.
    await d.anfragen(false, 'anna');
    await d.laufend;
    st = await d.status();
    assert.deepEqual([st.zertifikat.domain, st.zertifikat.test, st.zertifikat.gueltig, st.umschaltenMoeglich], [DOMAIN, false, true, true]);
    assert.deepEqual(await readdir(path.join(d.konfig.datenOrdner, 'zertifikat')), ['konto.pem', 'schluessel.pem', 'zertifikat.pem']);

    const r = await d.umschalten('anna');
    assert.deepEqual(r, { neustart: true, adresse: `https://${DOMAIN}:${HTTPS_PORT}/` });
    assert.deepEqual(ports, [HTTPS_PORT], 'Port vorher geprüft');
    const roh = await datei();
    assert.deepEqual([roh.tls.modus, roh.port, roh.hostname, 'staging' in roh.tls], ['letsencrypt', HTTPS_PORT, DOMAIN, false]);
    const k = pruefeKonfiguration(roh, ordner);
    assert.deepEqual([k.tls.modus, k.tls.dnsAnbieter, k.tls.email, k.tls.staging], ['letsencrypt', 'hetzner', 'it@konsum-weimar.de', false], 'config.json gültig für den Neustart');
    await new Promise((res) => setTimeout(res, 600));
    assert.equal(neustarts.length, 1);
    assert.ok(log.some((z) => /Umschalten auf HTTPS .* durch anna/.test(z)));

    // Nach dem Neustart (läuft HTTPS): zurück auf HTTP geht, erneut umschalten ist „bereits aktiv“.
    d.konfig = { ...d.konfig, port: HTTPS_PORT, hostname: DOMAIN, tls: { modus: 'letsencrypt' } };
    assert.match((await d.status()).umschaltenGrund, /bereits aktiv/);
    // Erneuern bei laufendem HTTPS: das echte Zertifikat wird sofort verwendet, ein Testzertifikat nie.
    const kontexte = [];
    d.server = { setSecureContext: (z) => kontexte.push(z) };
    await d.anfragen(true, 'anna');
    await d.laufend;
    assert.equal(kontexte.length, 0);
    await d.anfragen(false, 'anna');
    await d.laufend;
    assert.deepEqual(kontexte.map((z) => z.cert), [echtZ.cert]);
    assert.ok(log.includes('Neues Zertifikat ist aktiv.'));
    const h = await d.aufHttp('anna');
    assert.equal(h.neustart, true);
    assert.deepEqual([(await datei()).tls.modus, (await datei()).port], ['aus', 8080]);
    d.konfig = { ...d.konfig, port: 8080, tls: { modus: 'aus' } };
    await assert.rejects(d.aufHttp('anna'), /bereits per HTTP/);
  } finally { await rm(ordner, { recursive: true, force: true }); }
});

test('Domain: Fehler bei Let\'s Encrypt, belegter Port, ohne Starter, abgelaufenes oder fremdes Zertifikat', async () => {
  const testZ = await zertifikat();
  const { ordner, d, log, datei } = await aufbau({
    roh: { hostname: DOMAIN, tls: { modus: 'aus', email: 'it@konsum-weimar.de', dns_anbieter: 'hetzner', hetzner_token: TOKEN } },
    acme: acmeFake({ test: testZ, echt: testZ, fehler: 'rateLimited: too many certificates' }), portPruefen: async () => 'belegt', neustart: null,
  });
  try {
    await d.anfragen(false, 'anna');
    await d.laufend;
    const st = await d.status();
    assert.deepEqual([st.vorgang.ok, st.vorgang.laeuft], [false, false]);
    assert.match(st.vorgang.fehler, /Let's Encrypt hat kein Zertifikat ausgestellt: rateLimited/);
    assert.ok(log.some((z) => /Zertifikat für monitoring\.konsum-weimar\.de nicht erhalten/.test(z)));

    // Zertifikat für eine andere Domain bzw. abgelaufen → kein Umschalten.
    const zOrdner = path.join(d.konfig.datenOrdner, 'zertifikat');
    await import('node:fs/promises').then((fs) => fs.mkdir(zOrdner, { recursive: true }));
    await writeFile(path.join(zOrdner, 'zertifikat.pem'), (await zertifikat({ aussteller: '(STAGING) Lets Encrypt' })).cert);
    assert.match((await d.status()).umschaltenGrund, /Zuerst das echte Zertifikat/, 'Testzertifikat im Betriebsordner reicht nicht');
    await writeFile(path.join(zOrdner, 'zertifikat.pem'), (await zertifikat({ name: 'andere.firma.de' })).cert);
    assert.match((await d.status()).umschaltenGrund, /gilt für andere\.firma\.de, nicht für monitoring/);
    await writeFile(path.join(zOrdner, 'zertifikat.pem'), (await zertifikat({ tage: 1 })).cert);
    d.jetzt = () => Date.now() + 3 * 86_400_000;
    assert.match((await d.status()).umschaltenGrund, /abgelaufen/);
    d.jetzt = () => Date.now();

    // Gültig, aber Port belegt: nichts wird geändert.
    assert.equal((await d.status()).umschaltenMoeglich, true);
    await assert.rejects(d.umschalten('anna'), /Port 8443 ist auf diesem Rechner nicht verfügbar \(belegt\)/);
    assert.equal((await datei()).tls.modus, 'aus');
    // Ohne Starter: gespeichert, Hinweis auf manuellen Neustart.
    d.portPruefen = async () => true;
    const r = await d.umschalten('anna');
    assert.deepEqual([r.neustart, (await datei()).tls.modus], [false, 'letsencrypt']);
    assert.match(r.hinweis, /Start\.exe --neustart/);
  } finally { await rm(ordner, { recursive: true, force: true }); }
});

test('Domain: zertifikatInfo und portFrei', async () => {
  const z = await zertifikat({ aussteller: '(STAGING) Lets Encrypt' });
  const i = zertifikatInfo(z.cert);
  assert.deepEqual([i.domain, i.aussteller, i.test, i.gueltig], [DOMAIN, '(STAGING) Lets Encrypt', true, true]);
  assert.equal(zertifikatInfo('kein pem'), null);
  assert.equal(zertifikatInfo(null), null);
  const belegt = net.createServer();
  await new Promise((r) => belegt.listen(0, '127.0.0.1', r));
  try {
    assert.equal(await portFrei(belegt.address().port, '127.0.0.1'), 'belegt');
    const frei = net.createServer();
    await new Promise((r) => frei.listen(0, '127.0.0.1', r));
    const p = frei.address().port;
    await new Promise((r) => frei.close(r));
    assert.equal(await portFrei(p, '127.0.0.1'), true);
  } finally { belegt.close(); }
});

test('Webserver: /api/tls nur für Admins aus dem Firmennetz, Token nie in Antworten', async () => {
  const { ordner, d } = await aufbau({ roh: { hostname: DOMAIN, tls: { modus: 'aus', email: 'it@konsum-weimar.de', dns_anbieter: 'hetzner', hetzner_token: TOKEN } } });
  const tls = await zertifikat({ name: 'localhost' });
  const anmeldung = new Anmeldung({ benutzer: { anna: { hash: await hashPasswort('Blaue-Kanne-41x'), admin: true }, bob: { hash: await hashPasswort('Rote-Leiter-52y') } }, sitzungMs: 60_000 });
  let intern = true;
  const server = await starteServer({ anwendung: erstelleAnwendung({ module: { ansichten: () => [], finde: () => null }, anmeldung, domain: d, sitzungMs: 60_000, adminNetz: () => intern }), tls, host: '127.0.0.1', port: 0 });
  const { port } = server.address();
  const anfrage = (methode, weg, { kopf = {}, koerper } = {}) => new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', servername: 'localhost', port, method: methode, path: weg, ca: tls.cert, headers: { host: `localhost:${port}`, ...kopf } }, (res) => {
      let t = ''; res.on('data', (x) => { t += x; }); res.on('end', () => resolve({ status: res.statusCode, text: t, json: () => JSON.parse(t) }));
    });
    req.on('error', reject); if (koerper) req.write(koerper); req.end();
  });
  const login = async (name, pw) => {
    const t = await anmeldung.anmelden(name, pw, '127.0.0.1');
    return `mb_sitzung=${t}`;
  };
  const post = (cookie, weg, wert, extra = {}) => anfrage('POST', weg, { kopf: { cookie, 'x-monitor-anfrage': '1', 'content-type': 'application/json', ...extra }, koerper: JSON.stringify(wert) });
  try {
    const anna = await login('anna', 'Blaue-Kanne-41x');
    const bob = await login('bob', 'Rote-Leiter-52y');
    let r = await anfrage('GET', '/api/tls', { kopf: { cookie: anna } });
    assert.equal(r.status, 200);
    assert.equal(r.json().hostname, DOMAIN);
    assert.doesNotMatch(r.text, new RegExp(TOKEN));
    assert.equal((await anfrage('GET', '/api/tls', { kopf: { cookie: bob } })).status, 403, 'kein Admin');
    r = await post(anna, '/api/tls/einstellungen', { hostname: 'x', email: 'y', dns_anbieter: 'hetzner' });
    assert.equal(r.status, 400);
    assert.ok(r.json().feldfehler.hostname);
    r = await post(anna, '/api/tls/pruefen', {});
    assert.equal(r.json().pruefung.zone.ok, true);
    r = await post(anna, '/api/tls/umschalten', {});
    assert.deepEqual([r.status, r.json().fehler], [400, 'Zuerst das echte Zertifikat anfragen.']);
    assert.equal((await post(anna, '/api/tls/pruefen', {}, { 'x-monitor-anfrage': '' })).status, 403, 'ohne eigenen Kopf');
    assert.equal((await post(anna, '/api/tls/pruefen', {}, { origin: 'https://boese.example' })).status, 403, 'fremde Herkunft');
    assert.equal((await anfrage('GET', '/api/tls/pruefen', { kopf: { cookie: anna } })).status, 404);
    intern = false;
    r = await anfrage('GET', '/api/tls', { kopf: { cookie: anna } });
    assert.deepEqual([r.status, r.json().fehler], [403, 'Admin-Funktionen nur aus dem Firmennetz oder über VPN.']);
  } finally {
    server.close();
    await rm(ordner, { recursive: true, force: true });
  }
});
