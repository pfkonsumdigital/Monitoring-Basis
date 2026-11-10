import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Anmeldung, hashPasswort } from '../basis/anmeldung.js';
import { Benutzerverwaltung } from '../basis/benutzerverwaltung.js';
import { MicrosoftAnmeldung, MicrosoftFehler } from '../basis/microsoft.js';
import { darf, pruefeRechte, rechteFehler, rechteText, stufe } from '../basis/rechte.js';
import { pruefeKonfiguration } from '../basis/konfiguration.js';
import { erstelleAnwendung, starteServer } from '../basis/webserver.js';

// Anmeldung mit Microsoft (Entra ID) und Rechte je Modul (0.19.0). Microsoft wird simuliert: eigene RSA-Schlüssel,
// Schlüsselliste (JWKS) und signierte ID-Tokens.

const ANBIETER = 'https://login.microsoftonline.test';
const TENANT = '11111111-2222-3333-4444-555555555555';
const CLIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OID_ANNA = '0a0a0a0a-0000-4000-8000-000000000001';
const OID_FREMD = '0b0b0b0b-0000-4000-8000-000000000002';

function schluesselpaar(kid) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, kty: 'RSA', use: 'sig' } };
}
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function idToken(paar, inhalt, kopf = {}) {
  const k = b64({ alg: 'RS256', kid: paar.kid, typ: 'JWT', ...kopf });
  const i = b64(inhalt);
  return `${k}.${i}.${sign('RSA-SHA256', Buffer.from(`${k}.${i}`), paar.privateKey).toString('base64url')}`;
}

// Simuliertes Microsoft: Schlüsselliste und Token-Endpunkt. naechstesToken(code, body) liefert das ID-Token.
function microsoftSimuliert() {
  const s = { paare: [schluesselpaar('k1')], aufrufe: [], tokenFehler: null, naechstesToken: null };
  s.fetchImpl = async (url, opt = {}) => {
    s.aufrufe.push({ url, body: opt.body ? String(opt.body) : null });
    if (url === `${ANBIETER}/${TENANT}/discovery/v2.0/keys`) return Response.json({ keys: s.paare.map((p) => p.jwk) });
    if (url === `${ANBIETER}/${TENANT}/oauth2/v2.0/token`) {
      if (s.tokenFehler) return Response.json({ error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret.' }, { status: 401 });
      const body = new URLSearchParams(String(opt.body));
      return Response.json({ id_token: s.naechstesToken(body), access_token: 'x', token_type: 'Bearer' });
    }
    throw new Error(`unerwartet: ${url}`);
  };
  return s;
}
const anspruch = (nonce, extra = {}) => ({ iss: `${ANBIETER}/${TENANT}/v2.0`, aud: CLIENT, tid: TENANT, oid: OID_ANNA, preferred_username: 'Anna.Schmidt@konsum-weimar.de', name: 'Anna Schmidt',
  nonce, iat: Math.floor(Date.now() / 1000), nbf: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, ...extra });

async function msAufbau(extra = {}) {
  const ordner = await mkdtemp(path.join(tmpdir(), 'mb-ms-'));
  const sim = microsoftSimuliert();
  const meldungen = [];
  const ms = new MicrosoftAnmeldung({ datenOrdner: ordner, fetchImpl: sim.fetchImpl, anbieter: ANBIETER, log: (m) => meldungen.push(m), ...extra });
  await ms.laden();
  await ms.speichern({ aktiv: true, tenant_id: TENANT, client_id: CLIENT, client_secret: 'Geheim~123' }, 'patrick');
  return { ordner, sim, ms, meldungen, aufraeumen: () => rm(ordner, { recursive: true, force: true }) };
}
// Startet einen Vorgang und schließt ihn mit dem passenden Token ab (tokenInhalt(nonce) → Ansprüche).
async function durchlauf(u, tokenInhalt = (n) => anspruch(n), { paar } = {}) {
  const { url, vorgang } = u.ms.starten('https://monitoring.konsum-weimar.de:8443/login/microsoft/rueckruf');
  const p = new URL(url).searchParams;
  u.sim.naechstesToken = () => idToken(paar ?? u.sim.paare[0], tokenInhalt(p.get('nonce')));
  return u.ms.abschliessen({ vorgang, state: p.get('state'), code: 'code-123' });
}

test('Rechte: Stufen, Grundrecht, Abweichungen, Admin, Benutzer vor 0.19.0', () => {
  assert.equal(stufe({ admin: true, rechte: { grund: 'kein' } }, 'ftp'), 'bedienen', 'Admin immer alles');
  assert.equal(stufe({}, 'ftp'), 'bedienen', 'ohne rechte: wie bisher');
  assert.equal(stufe(undefined, 'ftp'), 'kein');
  const r = { rechte: { grund: 'sehen', module: { ftp: 'bedienen', backup: 'kein' } } };
  assert.deepEqual(['ftp', 'backup', 'neu'].map((id) => stufe(r, id)), ['bedienen', 'kein', 'sehen']);
  assert.equal(darf(r, 'neu', 'sehen'), true);
  assert.equal(darf(r, 'neu', 'bedienen'), false);
  assert.equal(darf(r, 'backup', 'sehen'), false);
  assert.equal(darf({ rechte: { grund: 'kein', module: {} } }, 'ftp', 'sehen'), false);
  assert.equal(stufe({ rechte: { grund: 'kein', module: { constructor: 'bedienen' } } }, 'toString'), 'kein', 'keine geerbten Schlüssel');

  assert.deepEqual(pruefeRechte({ grund: 'sehen', module: { ftp: 'bedienen', backup: 'sehen' } }).werte, { grund: 'sehen', module: { ftp: 'bedienen' } }, 'gleich dem Grundrecht entfällt');
  assert.match(pruefeRechte({ grund: 'alles' }).fehler, /Grundrecht/);
  assert.match(pruefeRechte({ grund: 'kein', module: { '../x': 'sehen' } }).fehler, /Modul-ID/);
  assert.match(pruefeRechte({ grund: 'kein', module: { ftp: 'alles' } }).fehler, /Stufe/);
  assert.equal(rechteFehler(undefined), null);
  assert.match(rechteFehler({ grund: 'sehen', module: { FTP: 'sehen' } }), /module\.FTP/);
  assert.equal(rechteText({ rechte: { grund: 'sehen', module: { ftp: 'bedienen' } } }, { ftp: 'FTP' }), 'Grundrecht sehen; FTP: bedienen');
});

test('config.json: Microsoft-Benutzer und Rechte werden geprüft', async () => {
  const hash = await hashPasswort('irgendwas-langes');
  const basis = { port: 8080, tls: { modus: 'aus' } };
  const k = pruefeKonfiguration({ ...basis, benutzer: { anna: { hash, microsoft: { adresse: 'anna@konsum-weimar.de', oid: OID_ANNA, tid: TENANT }, rechte: { grund: 'sehen', module: { ftp: 'bedienen' } } } } }, '/x/config.json');
  assert.equal(k.benutzer.anna.microsoft.oid, OID_ANNA);
  assert.throws(() => pruefeKonfiguration({ ...basis, benutzer: { anna: { hash, microsoft: { adresse: 'keine-adresse' } } } }, '/x/config.json'), /microsoft ist ungültig/);
  assert.throws(() => pruefeKonfiguration({ ...basis, benutzer: { anna: { hash, microsoft: { adresse: 'a@b.de', oid: 'x' } } } }, '/x/config.json'), /microsoft ist ungültig/);
  assert.throws(() => pruefeKonfiguration({ ...basis, benutzer: { anna: { hash, rechte: { grund: 'alles' } } } }, '/x/config.json'), /rechte: grund/);
});

test('Microsoft: Anmeldeadresse mit PKCE, Prüfung des ID-Tokens, Einmal-Vorgang', async () => {
  const u = await msAufbau();
  try {
    assert.equal(u.ms.eingerichtet(), true);
    assert.deepEqual(u.ms.ansicht().werte.client_secret, { gesetzt: true });
    assert.doesNotMatch(JSON.stringify(u.ms.ansicht()), /Geheim~123/);
    const { url, vorgang } = u.ms.starten('https://monitoring.konsum-weimar.de:8443/login/microsoft/rueckruf');
    const a = new URL(url);
    assert.equal(`${a.origin}${a.pathname}`, `${ANBIETER}/${TENANT}/oauth2/v2.0/authorize`);
    const p = a.searchParams;
    assert.deepEqual([p.get('client_id'), p.get('response_type'), p.get('scope'), p.get('code_challenge_method'), p.get('redirect_uri')],
      [CLIENT, 'code', 'openid profile email', 'S256', 'https://monitoring.konsum-weimar.de:8443/login/microsoft/rueckruf']);
    assert.ok(p.get('state').length >= 32 && p.get('nonce').length >= 32 && p.get('code_challenge').length === 43);

    u.sim.naechstesToken = (body) => {
      // Code-Einlösung mit Schlüssel, Rückkehr-Adresse und PKCE-Verifier.
      assert.equal(body.get('client_secret'), 'Geheim~123');
      assert.equal(body.get('code'), 'code-123');
      assert.equal(body.get('redirect_uri'), p.get('redirect_uri'));
      assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), p.get('code_challenge'));
      return idToken(u.sim.paare[0], anspruch(p.get('nonce')));
    };
    const r = await u.ms.abschliessen({ vorgang, state: p.get('state'), code: 'code-123' });
    assert.deepEqual(r, { oid: OID_ANNA, tid: TENANT, adresse: 'Anna.Schmidt@konsum-weimar.de', anzeigename: 'Anna Schmidt' });
    await assert.rejects(u.ms.abschliessen({ vorgang, state: p.get('state'), code: 'code-123' }), /abgelaufen oder unbekannt/, 'nur einmal');

    // falscher state
    const v2 = u.ms.starten('https://x/login/microsoft/rueckruf');
    await assert.rejects(u.ms.abschliessen({ vorgang: v2.vorgang, state: 'falsch', code: 'c' }), /state/);
    await assert.rejects(u.ms.abschliessen({ vorgang: v2.vorgang, state: new URL(v2.url).searchParams.get('state'), code: 'c' }), /abgelaufen oder unbekannt/, 'nach Fehlversuch verbraucht');
    // Fehler von Microsoft (z. B. Abbruch durch den Benutzer)
    const v3 = u.ms.starten('https://x/r');
    await assert.rejects(u.ms.abschliessen({ vorgang: v3.vorgang, state: new URL(v3.url).searchParams.get('state'), fehler: 'access_denied', fehlerText: 'AADSTS50020: User abgelehnt\nTrace' }), /access_denied – AADSTS50020: User abgelehnt$/);
  } finally { await u.aufraeumen(); }
});

test('Microsoft: ungültige Tokens werden abgelehnt', async () => {
  const u = await msAufbau();
  try {
    const fremd = schluesselpaar('k1'); // gleiche Schlüssel-ID, anderer Schlüssel
    await assert.rejects(durchlauf(u, (n) => anspruch(n), { paar: fremd }), /Signatur ungültig/);
    await assert.rejects(durchlauf(u, (n) => anspruch(n, { iss: `${ANBIETER}/99999999-2222-3333-4444-555555555555/v2.0` })), /falscher Aussteller/);
    await assert.rejects(durchlauf(u, (n) => anspruch(n, { aud: '99999999-bbbb-cccc-dddd-eeeeeeeeeeee' })), /andere Anwendung/);
    await assert.rejects(durchlauf(u, (n) => anspruch(n, { tid: '99999999-2222-3333-4444-555555555555' })), /anderer Mandant/);
    await assert.rejects(durchlauf(u, (n) => anspruch(n, { exp: Math.floor(Date.now() / 1000) - 600 })), /abgelaufen/);
    await assert.rejects(durchlauf(u, (n) => anspruch(n, { nbf: Math.floor(Date.now() / 1000) + 3600 })), /noch nicht gültig/);
    await assert.rejects(durchlauf(u, () => anspruch('anderer-einmalwert')), /Einmalwert/);
    await assert.rejects(durchlauf(u, (n) => anspruch(n, { oid: 'keine-guid' })), /keine Konto-ID/);
    // alg „none“ bzw. HS256 wird nicht akzeptiert.
    const { url, vorgang } = u.ms.starten('https://x/r');
    const p = new URL(url).searchParams;
    u.sim.naechstesToken = () => `${b64({ alg: 'none', kid: 'k1' })}.${b64(anspruch(p.get('nonce')))}.`;
    await assert.rejects(u.ms.abschliessen({ vorgang, state: p.get('state'), code: 'c' }), /falsches Verfahren/);
    // Code-Einlösung scheitert (z. B. abgelaufener Schlüssel in Entra)
    u.sim.tokenFehler = true;
    await assert.rejects(durchlauf(u), /AADSTS7000215/);
  } finally { await u.aufraeumen(); }
});

test('Microsoft: Schlüsselwechsel wird nachgeladen, Schlüsselliste zwischengespeichert', async () => {
  const u = await msAufbau();
  try {
    await durchlauf(u);
    await durchlauf(u);
    const abrufe = () => u.sim.aufrufe.filter((a) => a.url.endsWith('/keys')).length;
    assert.equal(abrufe(), 1, 'zwischengespeichert');
    const neu = schluesselpaar('k2');
    u.sim.paare.push(neu);
    assert.equal((await durchlauf(u, (n) => anspruch(n), { paar: neu })).oid, OID_ANNA);
    assert.equal(abrufe(), 2, 'unbekannte Schlüssel-ID → einmal neu geladen');
    await assert.rejects(durchlauf(u, (n) => anspruch(n), { paar: schluesselpaar('k3') }), /Unbekannter Signaturschlüssel/);
  } finally { await u.aufraeumen(); }
});

test('Microsoft: Einstellungen prüfen, nicht eingerichtet, abgelaufener Vorgang', async () => {
  let uhr = Date.now();
  const u = await msAufbau({ jetzt: () => uhr });
  try {
    assert.ok((await u.ms.speichern({ tenant_id: 'konsum-weimar.de' }, 'p')).feldfehler.tenant_id);
    assert.ok((await u.ms.speichern({ client_id: 'abc' }, 'p')).feldfehler.client_id);
    assert.deepEqual((await u.ms.speichern({ client_secret: '' }, 'p')).geaendert, [], 'leerer Schlüssel = behalten');
    const datei = JSON.parse(await readFile(path.join(u.ordner, 'microsoft.json'), 'utf8'));
    assert.equal(datei.tenant_id, TENANT);
    const { url, vorgang } = u.ms.starten('https://x/r');
    uhr += 11 * 60_000;
    await assert.rejects(u.ms.abschliessen({ vorgang, state: new URL(url).searchParams.get('state'), code: 'c' }), /abgelaufen/);
    await u.ms.speichern({ aktiv: false }, 'p');
    assert.throws(() => u.ms.starten('https://x/r'), MicrosoftFehler);
    assert.ok((await u.ms.speichern({ aktiv: true, client_secret: '' }, 'p')).geaendert, 'Schlüssel bleibt erhalten');
    assert.equal(u.ms.eingerichtet(), true);
  } finally { await u.aufraeumen(); }
});

// ---- Webserver: kompletter Ablauf ----
const MODULE = [{ id: 'ftp', name: 'FTP', anzeige: 'ok' }, { id: 'backup', name: 'Backup', anzeige: 'fehler' }];
function testModule() {
  const aufrufe = [];
  return {
    aufrufe,
    ansichten: () => MODULE.map((m) => ({ ...m })),
    finde: (id) => MODULE.find((m) => m.id === id) ?? null,
    verlauf: () => [],
    jetztPruefen: (id) => { aufrufe.push(['pruefen', id]); return { code: 'gestartet' }; },
    setzeAktiv: async (id, aktiv) => { aufrufe.push(['aktiv', id, aktiv]); },
  };
}

async function webAufbau() {
  const u = await msAufbau();
  const configDatei = path.join(u.ordner, 'config.json');
  const benutzer = {
    chef: { hash: await hashPasswort('geheim-geheim'), admin: true },
    alt: { hash: await hashPasswort('geheim-geheim') }, // vor 0.19.0 angelegt: keine „rechte“
  };
  await writeFile(configDatei, JSON.stringify({ port: 8443, tls: { modus: 'aus' }, benutzer }));
  const meldungen = [];
  const anmeldung = new Anmeldung({ benutzer, sitzungMs: 60_000, melden: (e) => meldungen.push(e) });
  const bv = new Benutzerverwaltung({ configDatei, anmeldung, log: (m) => meldungen.push(m) });
  const module = testModule();
  let intern = true;
  const app = { anwendung: null };
  const server = await starteServer({ anwendung: (req, res) => app.anwendung(req, res), tls: null, host: '127.0.0.1', port: 0 });
  const { port } = server.address();
  const adresse = `http://127.0.0.1:${port}`;
  app.anwendung = erstelleAnwendung({ microsoft: u.ms, microsoftAdresse: adresse, module, benutzerverwaltung: bv, anmeldung, sitzungMs: 60_000, verschluesselt: false, hostname: '127.0.0.1', adminNetz: () => intern, log: (m) => meldungen.push(m) });
  const hole = (methode, weg, kopf = {}, koerper) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: methode, path: weg, headers: { host: `127.0.0.1:${port}`, ...kopf } }, (res) => {
      let daten = ''; res.on('data', (t) => { daten += t; }); res.on('end', () => resolve({ status: res.statusCode, kopf: res.headers, text: daten, json: () => JSON.parse(daten) }));
    });
    req.on('error', reject); if (koerper) req.write(koerper); req.end();
  });
  const lokal = async (name) => {
    const r = await hole('POST', '/login', { 'content-type': 'application/x-www-form-urlencoded', origin: adresse }, `benutzer=${name}&passwort=geheim-geheim`);
    return r.kopf['set-cookie']?.[0]?.startsWith('mb_sitzung=') ? { cookie: r.kopf['set-cookie'][0].split(';')[0] } : null;
  };
  // Anmeldung mit Microsoft wie im Browser: Start, „Microsoft“, Rückkehr mit Code.
  const mitMicrosoft = async (tokenInhalt = (n) => anspruch(n)) => {
    const start = await hole('GET', '/login/microsoft');
    assert.equal(start.status, 303);
    const vorgangCookie = start.kopf['set-cookie'][0];
    assert.match(vorgangCookie, /^mb_ms=[^;]+; Path=\/login\/microsoft; HttpOnly; SameSite=Lax; Max-Age=600$/);
    const p = new URL(start.kopf.location).searchParams;
    assert.equal(p.get('redirect_uri'), `${adresse}/login/microsoft/rueckruf`);
    u.sim.naechstesToken = () => idToken(u.sim.paare[0], tokenInhalt(p.get('nonce')));
    const r = await hole('GET', `/login/microsoft/rueckruf?code=abc&state=${encodeURIComponent(p.get('state'))}`, { cookie: vorgangCookie.split(';')[0] });
    const sitzung = (Array.isArray(r.kopf['set-cookie']) ? r.kopf['set-cookie'] : []).find((c) => c.startsWith('mb_sitzung=') && !c.startsWith('mb_sitzung=;'));
    return { r, cookie: sitzung ? { cookie: sitzung.split(';')[0] } : null };
  };
  const schutz = { 'x-monitor-anfrage': '1', 'content-type': 'application/json' };
  return { u, bv, anmeldung, module, meldungen, hole, lokal, mitMicrosoft, schutz, configDatei, setIntern: (w) => { intern = w; },
    aufraeumen: async () => { server.close(); await u.aufraeumen(); } };
}

test('Webserver: Anmeldung mit Microsoft nur für angelegte Benutzer, Verknüpfung über Konto-ID', async () => {
  const w = await webAufbau();
  try {
    const login = await w.hole('GET', '/login');
    assert.match(login.text, /href="\/login\/microsoft">Mit Microsoft anmelden/);
    // Nicht angelegt → kein Zugang.
    const unbekannt = await w.mitMicrosoft();
    assert.equal(unbekannt.cookie, null);
    assert.equal(unbekannt.r.kopf.location, '/login?fehler=ms-unbekannt');
    assert.ok(w.meldungen.some((m) => /Microsoft-Anmeldung abgewiesen: Anna\.Schmidt@konsum-weimar\.de/.test(m)));

    // Admin legt anna als Microsoft-Benutzer an (Adresse in anderer Schreibweise).
    const chef = await w.lokal('chef');
    assert.equal((await w.hole('POST', '/api/benutzer', { ...chef, ...w.schutz }, JSON.stringify({ name: 'anna', art: 'microsoft', adresse: 'anna.schmidt@konsum-weimar.de' }))).status, 200);
    assert.equal((await w.hole('POST', '/api/benutzer', { ...chef, ...w.schutz }, JSON.stringify({ name: 'anna2', art: 'microsoft', adresse: 'ANNA.schmidt@konsum-weimar.de' }))).json().fehler, 'Die Microsoft-Adresse ist schon dem Benutzer „anna“ zugeordnet.');
    const ok = await w.mitMicrosoft();
    assert.ok(ok.cookie, 'angemeldet');
    assert.equal(ok.r.status, 200);
    assert.match(ok.r.text, /http-equiv="refresh" content="0;url=\/"/, 'Weiterleitung per Seite (SameSite=Strict)');
    assert.ok(ok.r.kopf['set-cookie'].some((c) => c.startsWith('mb_ms=;')), 'Vorgangs-Cookie gelöscht');
    const status = (await w.hole('GET', '/api/status', ok.cookie)).json();
    assert.equal(status.benutzer, 'anna');
    assert.equal(status.anmeldeart, 'microsoft');
    const datei = JSON.parse(await readFile(w.configDatei, 'utf8'));
    assert.deepEqual(datei.benutzer.anna.microsoft, { adresse: 'anna.schmidt@konsum-weimar.de', oid: OID_ANNA, tid: TENANT });
    assert.deepEqual(datei.benutzer.anna.rechte, { grund: 'kein', module: {} });
    assert.match(datei.benutzer.anna.hash, /^scrypt\$/, 'Platzhalter-Hash für ältere Versionen');

    // Adresse in Entra geändert: zählt die Konto-ID.
    assert.ok((await w.mitMicrosoft((n) => anspruch(n, { preferred_username: 'a.schmidt@konsum-weimar.de' }))).cookie);
    // Fremdes Konto mit der Adresse von anna: abgewiesen.
    const fremd = await w.mitMicrosoft((n) => anspruch(n, { oid: OID_FREMD }));
    assert.equal(fremd.cookie, null);
    assert.ok(w.meldungen.some((m) => /gehört zu anna, ist aber mit einem anderen Microsoft-Konto verknüpft/.test(m)));
    // Admin setzt die Adresse neu → Verknüpfung gelöst, das neue Konto wird beim nächsten Anmelden verknüpft.
    assert.equal((await w.hole('POST', '/api/benutzer/anna/microsoft', { ...chef, ...w.schutz }, JSON.stringify({ adresse: 'anna.schmidt@konsum-weimar.de' }))).status, 200);
    assert.equal((await w.hole('GET', '/api/status', ok.cookie)).status, 401, 'Sitzungen beendet');
    assert.ok((await w.mitMicrosoft((n) => anspruch(n, { oid: OID_FREMD }))).cookie);
    assert.equal(JSON.parse(await readFile(w.configDatei, 'utf8')).benutzer.anna.microsoft.oid, OID_FREMD);

    // Kein Passwort-Login für Microsoft-Benutzer, kein Passwort setzen.
    w.anmeldung.benutzer.anna.hash = await hashPasswort('geheim-geheim');
    assert.equal(await w.lokal('anna'), null);
    assert.equal((await w.hole('POST', '/api/benutzer/anna/passwort', { ...chef, ...w.schutz }, JSON.stringify({ passwort: 'Blaue-Kanne-41x-neu' }))).status, 400);

    // Ungültiges Token → Fehlerseite, keine Sitzung.
    const kaputt = await w.mitMicrosoft((n) => anspruch(n, { aud: '99999999-bbbb-cccc-dddd-eeeeeeeeeeee' }));
    assert.equal(kaputt.r.kopf.location, '/login?fehler=ms-fehler');
    assert.equal(kaputt.cookie, null);
    // Ohne Vorgangs-Cookie (z. B. Angreifer schickt den Link): abgewiesen.
    assert.equal((await w.hole('GET', '/login/microsoft/rueckruf?code=abc&state=x')).kopf.location, '/login?fehler=ms-fehler');
    // Aufruf über anderen Host-Namen → erst auf die eingerichtete Adresse.
  } finally { await w.aufraeumen(); }
});

test('Webserver: Rechte je Modul – Übersicht, Details, Prüfen, Pause, Admin vergibt Rechte', async () => {
  const w = await webAufbau();
  try {
    const chef = await w.lokal('chef');
    await w.hole('POST', '/api/benutzer', { ...chef, ...w.schutz }, JSON.stringify({ name: 'anna', art: 'microsoft', adresse: 'anna.schmidt@konsum-weimar.de' }));
    const anna = (await w.mitMicrosoft()).cookie;
    // Neuer Benutzer: nichts.
    assert.deepEqual((await w.hole('GET', '/api/status', anna)).json().module, []);
    assert.equal((await w.hole('GET', '/api/module/ftp/verlauf', anna)).status, 404);
    assert.equal((await w.hole('POST', '/api/module/ftp/pruefen', { ...anna, ...w.schutz })).status, 404);
    // Rechte: nur Admins, Schutzkopf, Prüfung.
    assert.equal((await w.hole('POST', '/api/benutzer/anna/rechte', { ...anna, ...w.schutz }, JSON.stringify({ grund: 'bedienen' }))).status, 403);
    assert.equal((await w.hole('POST', '/api/benutzer/anna/rechte', chef, JSON.stringify({ grund: 'sehen' }))).status, 403, 'ohne Schutzkopf');
    assert.equal((await w.hole('POST', '/api/benutzer/anna/rechte', { ...chef, ...w.schutz }, JSON.stringify({ grund: 'alles' }))).status, 400);
    const r = await w.hole('POST', '/api/benutzer/anna/rechte', { ...chef, ...w.schutz }, JSON.stringify({ grund: 'sehen', module: { backup: 'kein', ftp: 'bedienen' } }));
    assert.equal(r.status, 200);
    assert.equal(r.json().benutzer.find((b) => b.name === 'anna').rechteText, 'Grundrecht sehen; Backup: kein; FTP: bedienen');
    // Sofort wirksam in der laufenden Sitzung.
    const s = (await w.hole('GET', '/api/status', anna)).json();
    assert.deepEqual(s.module.map((m) => [m.id, m.recht]), [['ftp', 'bedienen']]);
    assert.equal((await w.hole('GET', '/api/module/backup/verlauf', anna)).status, 404, 'unsichtbar');
    assert.equal((await w.hole('POST', '/api/module/ftp/pruefen', { ...anna, ...w.schutz })).status, 202);
    assert.equal((await w.hole('POST', '/api/module/ftp/aktiv', { ...anna, ...w.schutz }, '{"aktiv":false}')).status, 200, 'Pause mit „bedienen“');
    await w.hole('POST', '/api/benutzer/anna/rechte', { ...chef, ...w.schutz }, JSON.stringify({ grund: 'sehen' }));
    assert.equal((await w.hole('POST', '/api/module/ftp/pruefen', { ...anna, ...w.schutz })).status, 403);
    assert.equal((await w.hole('POST', '/api/module/ftp/aktiv', { ...anna, ...w.schutz }, '{"aktiv":true}')).status, 403);
    assert.equal((await w.hole('GET', '/api/module/backup/verlauf', anna)).status, 200);
    assert.equal((await w.hole('GET', '/api/module/ftp/einstellungen', anna)).status, 403, 'Einstellungen bleiben Admin');
    assert.deepEqual(w.module.aufrufe, [['pruefen', 'ftp'], ['aktiv', 'ftp', false]]);

    // Benutzer vor 0.19.0: wie bisher alles sehen und bedienen.
    const alt = await w.lokal('alt');
    assert.deepEqual((await w.hole('GET', '/api/status', alt)).json().module.map((m) => [m.id, m.recht]), [['ftp', 'bedienen'], ['backup', 'bedienen']]);
    // Admin von außen: sieht und bedient alles, aber keine Admin-Funktionen.
    w.setIntern(false);
    const st = (await w.hole('GET', '/api/status', chef)).json();
    assert.equal(st.admin, false);
    assert.deepEqual(st.module.map((m) => m.recht), ['bedienen', 'bedienen']);
    assert.equal((await w.hole('POST', '/api/benutzer/anna/rechte', { ...chef, ...w.schutz }, JSON.stringify({ grund: 'kein' }))).status, 403);
    w.setIntern(true);

    // Neuer lokaler Benutzer mit Grundrecht beim Anlegen.
    assert.equal((await w.hole('POST', '/api/benutzer', { ...chef, ...w.schutz }, JSON.stringify({ name: 'lager', passwort: 'Blaue-Kanne-41x-Tisch', grund: 'sehen' }))).status, 200);
    assert.deepEqual(JSON.parse(await readFile(w.configDatei, 'utf8')).benutzer.lager.rechte, { grund: 'sehen', module: {} });
    assert.equal((await w.hole('POST', '/api/benutzer', { ...chef, ...w.schutz }, JSON.stringify({ name: 'x', art: 'microsoft', adresse: 'kein-mail' }))).status, 400);
  } finally { await w.aufraeumen(); }
});

test('Webserver: Einstellungen der Microsoft-Anmeldung nur für Admins, Schlüssel nie zurück', async () => {
  const w = await webAufbau();
  try {
    const chef = await w.lokal('chef');
    const alt = await w.lokal('alt');
    assert.equal((await w.hole('GET', '/api/microsoft', alt)).status, 403);
    const r = (await w.hole('GET', '/api/microsoft', chef)).json();
    assert.equal(r.eingerichtet, true);
    assert.match(r.rueckAdresse, /^http:\/\/127\.0\.0\.1:\d+\/login\/microsoft\/rueckruf$/);
    assert.doesNotMatch(JSON.stringify(r), /Geheim~123/);
    assert.equal((await w.hole('POST', '/api/microsoft', chef, '{"werte":{"aktiv":false}}')).status, 403, 'ohne Schutzkopf');
    const aus = await w.hole('POST', '/api/microsoft', { ...chef, ...w.schutz }, JSON.stringify({ werte: { aktiv: false } }));
    assert.equal(aus.json().eingerichtet, false);
    assert.doesNotMatch((await w.hole('GET', '/login')).text, /Mit Microsoft anmelden/, 'Knopf nur, wenn eingerichtet');
    assert.equal((await w.hole('GET', '/login/microsoft')).kopf.location, '/login?fehler=ms-aus');
    const falsch = await w.hole('POST', '/api/microsoft', { ...chef, ...w.schutz }, JSON.stringify({ werte: { tenant_id: 'firma.de' } }));
    assert.equal(falsch.status, 400);
    assert.ok(falsch.json().feldfehler.tenant_id);
  } finally { await w.aufraeumen(); }
});

test('Webserver: Aufruf über einen anderen Host-Namen wird auf die eingerichtete Adresse umgeleitet', async () => {
  const w = await webAufbau();
  try {
    const r = await w.hole('GET', '/login/microsoft', { host: 'localhost' });
    // localhost ist erlaubt (Host-Prüfung), aber nicht die eingerichtete Adresse.
    assert.equal(r.status, 303);
    assert.match(r.kopf.location, /^http:\/\/127\.0\.0\.1:\d+\/login\/microsoft$/);
    assert.equal(r.kopf['set-cookie'], undefined, 'kein Vorgang auf dem falschen Namen');
  } finally { await w.aufraeumen(); }
});

test('Anmeldung: Microsoft-Sitzung nur für Microsoft-Benutzer', async () => {
  const hash = await hashPasswort('geheim-geheim');
  const a = new Anmeldung({ benutzer: { lokal: { hash }, anna: { hash, microsoft: { adresse: 'anna@konsum-weimar.de' } } }, sitzungMs: 60_000 });
  assert.equal(a.microsoftSitzung('lokal', '127.0.0.1'), null, 'lokales Konto nicht über Microsoft');
  assert.equal(a.microsoftSitzung('unbekannt', '127.0.0.1'), null);
  assert.equal(a.sitzung(a.microsoftSitzung('anna', '127.0.0.1')).benutzer, 'anna');
});
