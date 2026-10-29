import https from 'node:https';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OEFFENTLICH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'oberflaeche');
const DATEIEN = {
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};
const SICHERHEIT = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'Strict-Transport-Security': 'max-age=31536000',
  'X-Content-Type-Options': 'nosniff',
  // same-origin statt no-referrer: sonst senden Browser bei Formularen "Origin: null"
  // und die Herkunftsprüfung würde jede Anmeldung ablehnen.
  'Referrer-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};
const COOKIE = 'mb_sitzung';

function senden(res, status, inhalt, typ = 'text/plain; charset=utf-8', kopf = {}) {
  res.writeHead(status, { ...SICHERHEIT, 'Content-Type': typ, ...kopf });
  res.end(inhalt);
}
const json = (res, status, wert) => senden(res, status, JSON.stringify(wert), 'application/json; charset=utf-8');
const weiter = (res, ziel, kopf = {}) => { res.writeHead(303, { ...SICHERHEIT, Location: ziel, ...kopf }); res.end(); };

function cookieLesen(req) {
  for (const teil of (req.headers.cookie || '').split(';')) {
    const [name, ...wert] = teil.trim().split('=');
    if (name === COOKIE) return wert.join('=');
  }
  return null;
}

function koerperLesen(req, max = 10_000) {
  return new Promise((resolve, reject) => {
    let daten = '';
    req.setEncoding('utf8');
    req.on('data', (teil) => {
      daten += teil;
      if (daten.length > max) { reject(new Error('zu groß')); req.destroy(); }
    });
    req.on('end', () => resolve(daten));
    req.on('error', reject);
  });
}

// Fremde Seiten dürfen keine Aktionen auslösen: Origin muss passen, falls der Browser ihn sendet.
const herkunftOk = (req) => !req.headers.origin || req.headers.origin === `https://${req.headers.host}`;

function modulAnsicht(modul, planer, speicher) {
  return {
    id: modul.id, name: modul.name, typ: modul.typ ?? null,
    aktiv: modul.fehler ? false : modul.aktiv, intervallMinuten: modul.intervallMinuten ?? null,
    fehler: modul.fehler ?? null,
    laeuft: planer.laeuft(modul.id), naechsterLauf: planer.naechster(modul.id),
    letztes: modul.fehler ? null : speicher.letztes(modul.id),
  };
}

export function erstelleAnwendung({ module, planer, speicher, anmeldung, sitzungMs, log = () => {} }) {
  const seiteCache = new Map();
  const seite = async (name) => {
    if (!seiteCache.has(name)) seiteCache.set(name, await readFile(path.join(OEFFENTLICH, name), 'utf8'));
    return seiteCache.get(name);
  };

  return async function verarbeiten(req, res) {
    try {
      const url = new URL(req.url, 'https://basis.invalid');
      const weg = url.pathname;

      if (req.method === 'GET' && DATEIEN[weg]) {
        const [datei, typ] = DATEIEN[weg];
        return senden(res, 200, await readFile(path.join(OEFFENTLICH, datei)), typ);
      }

      if (weg === '/login' && req.method === 'GET') {
        const meldung = { '1': 'Benutzername oder Passwort falsch.', gesperrt: 'Zu viele Fehlversuche. Bitte 15 Minuten warten.' }[url.searchParams.get('fehler')] ?? '';
        const html = (await seite('login.html')).replace('{{meldung}}', meldung);
        return senden(res, 200, html, 'text/html; charset=utf-8');
      }
      if (weg === '/login' && req.method === 'POST') {
        if (!herkunftOk(req)) return senden(res, 403, 'Anfrage abgelehnt.');
        const felder = new URLSearchParams(await koerperLesen(req));
        const ergebnis = await anmeldung.anmelden(felder.get('benutzer') ?? '', felder.get('passwort') ?? '', req.socket.remoteAddress);
        if (ergebnis === 'gesperrt') { log(`Anmeldung gesperrt für ${req.socket.remoteAddress}.`); return weiter(res, '/login?fehler=gesperrt'); }
        if (!ergebnis) return weiter(res, '/login?fehler=1');
        log(`Anmeldung: ${felder.get('benutzer')} von ${req.socket.remoteAddress}.`);
        return weiter(res, '/', { 'Set-Cookie': `${COOKIE}=${ergebnis}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(sitzungMs / 1000)}` });
      }

      const token = cookieLesen(req);
      const sitzung = anmeldung.sitzung(token);
      if (!sitzung) {
        if (weg.startsWith('/api/')) return json(res, 401, { fehler: 'Nicht angemeldet.' });
        return weiter(res, '/login');
      }

      if (weg === '/logout' && req.method === 'POST') {
        if (!herkunftOk(req)) return senden(res, 403, 'Anfrage abgelehnt.');
        anmeldung.abmelden(token);
        return weiter(res, '/login', { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` });
      }
      if (weg === '/' && req.method === 'GET') return senden(res, 200, await seite('index.html'), 'text/html; charset=utf-8');

      if (weg === '/api/status' && req.method === 'GET') {
        return json(res, 200, { benutzer: sitzung.benutzer, serverZeit: new Date().toISOString(), module: module.map((m) => modulAnsicht(m, planer, speicher)) });
      }
      const treffer = /^\/api\/module\/([a-z0-9-]+)\/(verlauf|pruefen)$/.exec(weg);
      const modul = treffer && module.find((m) => m.id === treffer[1]);
      if (treffer && !modul) return json(res, 404, { fehler: 'Modul unbekannt.' });
      if (treffer?.[2] === 'verlauf' && req.method === 'GET') {
        const anzahl = Math.min(Math.max(Number.parseInt(url.searchParams.get('anzahl') ?? '50', 10) || 50, 1), 1000);
        return json(res, 200, { id: modul.id, verlauf: speicher.verlauf(modul.id, anzahl) });
      }
      if (treffer?.[2] === 'pruefen' && req.method === 'POST') {
        // Eigener Kopf erzwingt eine Same-Origin-Anfrage per fetch; einfache Formulare fremder Seiten scheitern.
        if (!herkunftOk(req) || req.headers['x-monitor-anfrage'] !== '1') return json(res, 403, { fehler: 'Anfrage abgelehnt.' });
        if (modul.fehler) return json(res, 409, { fehler: 'Das Modul ist fehlerhaft konfiguriert.' });
        if (!planer.jetztPruefen(modul.id)) return json(res, 409, { fehler: 'Die Prüfung läuft bereits.' });
        log(`Prüfung von ${modul.id} manuell gestartet durch ${sitzung.benutzer}.`);
        return json(res, 202, { gestartet: true });
      }
      return senden(res, 404, 'Nicht gefunden.');
    } catch (fehler) {
      log(`Fehler bei ${req.method} ${req.url}: ${fehler?.message || fehler}`);
      if (!res.headersSent) senden(res, 500, 'Interner Fehler.');
      else res.destroy();
    }
  };
}

export function starteServer({ anwendung, tls, host, port }) {
  return new Promise((resolve, reject) => {
    const server = https.createServer({ key: tls.key, cert: tls.cert, minVersion: 'TLSv1.2' }, anwendung);
    server.headersTimeout = 15_000;
    server.requestTimeout = 30_000;
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(server); });
  });
}
