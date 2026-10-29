import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { melde } from './protokoll.js';

const OEFFENTLICH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'oberflaeche');
const DATEIEN = {
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};
const SICHERHEIT = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
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

// Private und lokale Adressen (IPv4 und IPv6, auch als ::ffff:a.b.c.d).
export function istInterneAdresse(adresse) {
  const a = String(adresse ?? '').toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
  if (v4) {
    const [x, y] = [Number(v4[1]), Number(v4[2])];
    return x === 10 || x === 127 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 169 && y === 254);
  }
  return a === '::1' || /^f[cd][0-9a-f]{0,2}:/.test(a) || /^fe[89ab][0-9a-f]?:/.test(a);
}

// verschluesselt=false: Betrieb per HTTP im internen Netz (tls.modus "aus"). Dann kein Secure-Cookie und kein HSTS,
// und mit nurIntern werden Anfragen von außerhalb privater Netze abgewiesen.
export function erstelleAnwendung({ module, modulupdates = null, benachrichtigung = null, anmeldung, updates, protokoll, neustart, beenden = null, sitzungMs, verschluesselt = true, nurIntern = false, log = () => {} }) {
  const schema = verschluesselt ? 'https' : 'http';
  const sicher = verschluesselt ? ' Secure;' : '';
  // Fremde Seiten dürfen keine Aktionen auslösen: Origin muss passen, falls der Browser ihn sendet.
  const herkunftOk = (req) => !req.headers.origin || req.headers.origin === `${schema}://${req.headers.host}`;
  const abgewiesen = new Set();
  const seiteCache = new Map();
  const seite = async (name) => {
    if (!seiteCache.has(name)) seiteCache.set(name, await readFile(path.join(OEFFENTLICH, name), 'utf8'));
    return seiteCache.get(name);
  };

  return async function verarbeiten(req, res) {
    try {
      if (verschluesselt) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
      if (nurIntern && !istInterneAdresse(req.socket.remoteAddress)) {
        // Jede fremde Adresse nur einmal melden, damit Scans das Protokoll nicht fluten.
        if (abgewiesen.size < 1000 && !abgewiesen.has(req.socket.remoteAddress)) {
          abgewiesen.add(req.socket.remoteAddress);
          melde(log, 'warnung', 'Webserver', `Zugriff von externer Adresse ${req.socket.remoteAddress} abgewiesen (nur internes Netz erlaubt).`);
        }
        return senden(res, 403, 'Zugriff nur aus dem internen Netz.');
      }
      const url = new URL(req.url, 'https://basis.invalid');
      const weg = url.pathname;

      if (req.method === 'GET' && DATEIEN[weg]) {
        const [datei, typ] = DATEIEN[weg];
        return senden(res, 200, await readFile(path.join(OEFFENTLICH, datei)), typ);
      }

      if (weg === '/login' && req.method === 'GET') {
        const meldung = { '1': 'Benutzername oder Passwort falsch.', gesperrt: 'Zu viele Fehlversuche. Bitte 15 Minuten warten.', update: 'Die Basis wurde neu gestartet. Bitte erneut anmelden.' }[url.searchParams.get('fehler')] ?? '';
        const html = (await seite('login.html')).replace('{{meldung}}', meldung);
        return senden(res, 200, html, 'text/html; charset=utf-8');
      }
      if (weg === '/login' && req.method === 'POST') {
        if (!herkunftOk(req)) return senden(res, 403, 'Anfrage abgelehnt.');
        const felder = new URLSearchParams(await koerperLesen(req));
        const ergebnis = await anmeldung.anmelden(felder.get('benutzer') ?? '', felder.get('passwort') ?? '', req.socket.remoteAddress);
        if (ergebnis === 'gesperrt') { melde(log, 'warnung', 'Anmeldung', `Anmeldung nach zu vielen Fehlversuchen gesperrt (Adresse ${req.socket.remoteAddress}, Benutzer ${JSON.stringify(String(felder.get('benutzer') ?? '').slice(0, 64))}).`); return weiter(res, '/login?fehler=gesperrt'); }
        if (!ergebnis) { log(`Fehlgeschlagene Anmeldung von ${req.socket.remoteAddress}.`); return weiter(res, '/login?fehler=1'); }
        log(`Anmeldung: ${felder.get('benutzer')} von ${req.socket.remoteAddress}.`);
        return weiter(res, '/', { 'Set-Cookie': `${COOKIE}=${ergebnis}; Path=/; HttpOnly;${sicher} SameSite=Strict; Max-Age=${Math.floor(sitzungMs / 1000)}` });
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
        return weiter(res, '/login', { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly;${sicher} SameSite=Strict; Max-Age=0` });
      }
      if (weg === '/' && req.method === 'GET') return senden(res, 200, await seite('index.html'), 'text/html; charset=utf-8');

      if (weg === '/api/status' && req.method === 'GET') {
        return json(res, 200, { benutzer: sitzung.benutzer, admin: sitzung.admin === true, neustartMoeglich: Boolean(sitzung.admin && neustart), beendenMoeglich: Boolean(sitzung.admin && beenden), version: updates?.installiert ?? null, updateVerfuegbar: Boolean(sitzung.admin && updates?.status().updateMoeglich), serverZeit: new Date().toISOString(),
          module: module.ansichten().map((m) => (sitzung.admin && modulupdates && m.repo ? { ...m, updateVerfuegbar: modulupdates.verfuegbar(m.id) } : m)) });
      }
      if (weg === '/api/beenden') {
        if (!sitzung.admin) return json(res, 403, { fehler: 'Nur für Admins.' });
        if (req.method !== 'POST') return json(res, 404, { fehler: 'Nicht gefunden.' });
        if (!herkunftOk(req) || req.headers['x-monitor-anfrage'] !== '1') return json(res, 403, { fehler: 'Anfrage abgelehnt.' });
        if (!beenden) return json(res, 409, { fehler: 'Beenden ist hier nicht möglich.' });
        let eingabe;
        try { eingabe = JSON.parse((await koerperLesen(req)) || '{}'); } catch { return json(res, 400, { fehler: 'Ungültige Eingabe.' }); }
        const mitModulen = eingabe?.module === true;
        log(`Beenden angefordert durch ${sitzung.benutzer}${mitModulen ? ' (mit allen Modulen)' : ''}.`);
        setTimeout(() => beenden({ benutzer: sitzung.benutzer, mitModulen }), 200);
        return json(res, 202, { beendet: true });
      }
      if (weg === '/api/protokoll' || weg === '/api/protokoll/download' || weg === '/api/neustart') {
        if (!sitzung.admin) return json(res, 403, { fehler: 'Nur für Admins.' });
        if (weg === '/api/neustart') {
          if (req.method !== 'POST') return json(res, 404, { fehler: 'Nicht gefunden.' });
          if (!herkunftOk(req) || req.headers['x-monitor-anfrage'] !== '1') return json(res, 403, { fehler: 'Anfrage abgelehnt.' });
          if (!neustart) return json(res, 409, { fehler: 'Die Basis wurde nicht über den Starter gestartet und kann sich nicht selbst neu starten.' });
          log(`Neustart angefordert durch ${sitzung.benutzer}.`);
          setTimeout(neustart, 200);
          return json(res, 202, { neustart: true });
        }
        if (req.method !== 'GET' || !protokoll) return json(res, 404, { fehler: 'Nicht gefunden.' });
        const stufe = ['warnung', 'fehler'].includes(url.searchParams.get('stufe')) ? url.searchParams.get('stufe') : undefined;
        const quelle = url.searchParams.get('quelle')?.slice(0, 100) || undefined;
        if (weg === '/api/protokoll/download') {
          const text = protokoll.lesen({ anzahl: 10_000, stufe, quelle }).reverse()
            .map((e) => `${e.zeit} [${e.stufe.toUpperCase()}] [${e.quelle}] ${e.meldung}${e.details ? `\n    ${e.details.replace(/\n/g, '\n    ')}` : ''}`).join('\n');
          return senden(res, 200, text + '\n', 'text/plain; charset=utf-8', { 'Content-Disposition': 'attachment; filename="fehlerprotokoll.txt"' });
        }
        const anzahl = Math.min(Math.max(Number.parseInt(url.searchParams.get('anzahl') ?? '200', 10) || 200, 1), 1000);
        const eintraege = protokoll.lesen({ anzahl, stufe, quelle });
        const quellen = [...new Set(protokoll.lesen({ anzahl: 2000 }).map((e) => String(e.quelle).replace(/^Modul .*/, 'Modul')))].sort();
        return json(res, 200, { eintraege, quellen });
      }

      if (weg === '/api/benachrichtigung' || weg === '/api/benachrichtigung/test') {
        if (!sitzung.admin) return json(res, 403, { fehler: 'Nur für Admins.' });
        if (!benachrichtigung) return json(res, 404, { fehler: 'Nicht verfügbar.' });
        if (weg === '/api/benachrichtigung' && req.method === 'GET') return json(res, 200, benachrichtigung.ansicht());
        if (req.method !== 'POST') return json(res, 404, { fehler: 'Nicht gefunden.' });
        if (!herkunftOk(req) || req.headers['x-monitor-anfrage'] !== '1') return json(res, 403, { fehler: 'Anfrage abgelehnt.' });
        if (weg === '/api/benachrichtigung/test') {
          const ergebnis = await benachrichtigung.testmail(sitzung.benutzer);
          return json(res, ergebnis.ok ? 200 : 409, { ...ergebnis, ...benachrichtigung.ansicht() });
        }
        let eingabe;
        try { eingabe = JSON.parse(await koerperLesen(req, 20_000)); } catch { return json(res, 400, { fehler: 'Ungültige Eingabe.' }); }
        const ergebnis = await benachrichtigung.speichern(eingabe?.werte, sitzung.benutzer);
        if (ergebnis.feldfehler) return json(res, 400, { fehler: 'Bitte die markierten Felder prüfen.', feldfehler: ergebnis.feldfehler });
        return json(res, 200, { geaendert: ergebnis.geaendert, ...benachrichtigung.ansicht() });
      }

      if (weg.startsWith('/api/updates')) {
        if (!sitzung.admin) return json(res, 403, { fehler: 'Nur für Admins.' });
        if (!updates) return json(res, 404, { fehler: 'Updates nicht verfügbar.' });
        if (weg === '/api/updates' && req.method === 'GET') return json(res, 200, updates.status());
        if (weg === '/api/updates/token' || weg === '/api/updates/token/pruefen') {
          if (req.method !== 'POST') return json(res, 404, { fehler: 'Nicht gefunden.' });
          if (!herkunftOk(req) || req.headers['x-monitor-anfrage'] !== '1') return json(res, 403, { fehler: 'Anfrage abgelehnt.' });
          if (weg === '/api/updates/token/pruefen') return json(res, 200, await updates.tokenTesten());
          let eingabe;
          try { eingabe = JSON.parse(await koerperLesen(req)); } catch { return json(res, 400, { fehler: 'Ungültige Eingabe.' }); }
          try {
            return json(res, 200, eingabe?.entfernen === true ? await updates.tokenEntfernen(sitzung.benutzer) : await updates.tokenSpeichern(eingabe?.token, sitzung.benutzer));
          } catch (fehler) {
            return json(res, 400, { fehler: fehler.message, status: updates.status() });
          }
        }
        const aktion = { '/api/updates/suchen': 'suchen', '/api/updates/installieren': 'installieren', '/api/updates/zurueck': 'zurueck' }[weg];
        if (!aktion || req.method !== 'POST') return json(res, 404, { fehler: 'Nicht gefunden.' });
        if (!herkunftOk(req) || req.headers['x-monitor-anfrage'] !== '1') return json(res, 403, { fehler: 'Anfrage abgelehnt.' });
        let version;
        if (aktion === 'installieren') {
          try { ({ version } = JSON.parse(await koerperLesen(req))); } catch { return json(res, 400, { fehler: 'Version fehlt.' }); }
        }
        log(`Update-Aktion „${aktion}“ durch ${sitzung.benutzer}.`);
        try {
          return json(res, aktion === 'suchen' ? 200 : 202, await (aktion === 'installieren' ? updates.installieren(String(version)) : updates[aktion]()));
        } catch (fehler) {
          return json(res, 409, { fehler: fehler.message, status: updates.status() });
        }
      }

      const upd = /^\/api\/module\/([a-z0-9-]+)\/update(?:\/(suchen|installieren|zurueck))?$/.exec(weg);
      if (upd) {
        if (!sitzung.admin) return json(res, 403, { fehler: 'Nur für Admins.' });
        if (!modulupdates || !module.finde(upd[1])) return json(res, 404, { fehler: 'Modul unbekannt.' });
        if (!upd[2] && req.method === 'GET') return json(res, 200, await modulupdates.status(upd[1]));
        if (!upd[2] || req.method !== 'POST') return json(res, 404, { fehler: 'Nicht gefunden.' });
        if (!herkunftOk(req) || req.headers['x-monitor-anfrage'] !== '1') return json(res, 403, { fehler: 'Anfrage abgelehnt.' });
        let version;
        if (upd[2] === 'installieren') {
          try { ({ version } = JSON.parse(await koerperLesen(req))); } catch { return json(res, 400, { fehler: 'Version fehlt.' }); }
        }
        try {
          const st = upd[2] === 'suchen' ? await modulupdates.suchen(upd[1])
            : upd[2] === 'installieren' ? await modulupdates.installieren(upd[1], String(version), sitzung.benutzer)
              : await modulupdates.zurueck(upd[1], sitzung.benutzer);
          return json(res, upd[2] === 'suchen' ? 200 : 202, st);
        } catch (fehler) {
          return json(res, 409, { fehler: fehler.message, status: await modulupdates.status(upd[1]) });
        }
      }

      const treffer = /^\/api\/module\/([a-z0-9-]+)\/(verlauf|pruefen|einstellungen|aktiv|beenden|starten)$/.exec(weg);
      const modul = treffer && module.finde(treffer[1]);
      if (treffer && !modul) return json(res, 404, { fehler: 'Modul unbekannt.' });
      if (treffer?.[2] === 'verlauf' && req.method === 'GET') {
        const anzahl = Math.min(Math.max(Number.parseInt(url.searchParams.get('anzahl') ?? '50', 10) || 50, 1), 1000);
        return json(res, 200, { id: modul.id, verlauf: module.verlauf(modul.id, anzahl) });
      }
      if (treffer?.[2] === 'pruefen' && req.method === 'POST') {
        // Eigener Kopf erzwingt eine Same-Origin-Anfrage per fetch; einfache Formulare fremder Seiten scheitern.
        if (!herkunftOk(req) || req.headers['x-monitor-anfrage'] !== '1') return json(res, 403, { fehler: 'Anfrage abgelehnt.' });
        const ergebnis = module.jetztPruefen(modul.id);
        if (ergebnis !== 'gestartet') return json(res, 409, { fehler: { fehlerhaft: 'Das Modul ist fehlerhaft konfiguriert.', eigenstaendig: 'Dieses Modul läuft eigenständig und meldet sich selbst.', laeuft: 'Die Prüfung läuft bereits.' }[ergebnis] ?? 'Nicht möglich.' });
        log(`Prüfung von ${modul.id} manuell gestartet durch ${sitzung.benutzer}.`);
        return json(res, 202, { gestartet: true });
      }
      if (treffer?.[2] === 'beenden' || treffer?.[2] === 'starten') {
        if (!sitzung.admin) return json(res, 403, { fehler: 'Nur für Admins.' });
        if (req.method !== 'POST') return json(res, 404, { fehler: 'Nicht gefunden.' });
        if (!herkunftOk(req) || req.headers['x-monitor-anfrage'] !== '1') return json(res, 403, { fehler: 'Anfrage abgelehnt.' });
        if (modul.fehler) return json(res, 409, { fehler: 'Das Modul ist fehlerhaft konfiguriert.' });
        const ergebnis = await (treffer[2] === 'beenden' ? module.beenden(modul.id, sitzung.benutzer) : module.starten(modul.id, sitzung.benutzer));
        if (!ergebnis) return json(res, 404, { fehler: 'Modul unbekannt.' });
        return json(res, ergebnis.fehler ? 409 : 200, ergebnis);
      }
      if (treffer?.[2] === 'einstellungen' || treffer?.[2] === 'aktiv') {
        if (!sitzung.admin) return json(res, 403, { fehler: 'Nur für Admins.' });
        if (modul.fehler) return json(res, 409, { fehler: 'Das Modul ist fehlerhaft konfiguriert.' });
        if (treffer[2] === 'einstellungen' && req.method === 'GET') return json(res, 200, await module.einstellungen(modul.id));
        if (req.method !== 'POST') return json(res, 404, { fehler: 'Nicht gefunden.' });
        if (!herkunftOk(req) || req.headers['x-monitor-anfrage'] !== '1') return json(res, 403, { fehler: 'Anfrage abgelehnt.' });
        let eingabe;
        try { eingabe = JSON.parse(await koerperLesen(req, 100_000)); } catch { return json(res, 400, { fehler: 'Ungültige Eingabe.' }); }
        if (treffer[2] === 'aktiv') {
          if (typeof eingabe?.aktiv !== 'boolean') return json(res, 400, { fehler: 'aktiv muss true oder false sein.' });
          await module.setzeAktiv(modul.id, eingabe.aktiv, sitzung.benutzer);
          return json(res, 200, { aktiv: eingabe.aktiv });
        }
        const ergebnis = await module.einstellungenAendern(modul.id, eingabe?.werte, sitzung.benutzer);
        if (ergebnis.feldfehler) return json(res, 400, { fehler: 'Bitte die markierten Felder prüfen.', feldfehler: ergebnis.feldfehler });
        return json(res, 200, { geaendert: ergebnis.geaendert, ...(await module.einstellungen(modul.id)) });
      }
      return senden(res, 404, 'Nicht gefunden.');
    } catch (fehler) {
      melde(log, 'fehler', 'Webserver', `Interner Fehler bei ${req.method} ${new URL(req.url, 'https://x').pathname}: ${fehler?.message || fehler}`, fehler);
      if (!res.headersSent) senden(res, 500, 'Interner Fehler.');
      else res.destroy();
    }
  };
}

// Ohne tls (null) läuft der Server per HTTP.
export function starteServer({ anwendung, tls, host, port }) {
  return new Promise((resolve, reject) => {
    const server = tls ? https.createServer({ key: tls.key, cert: tls.cert, minVersion: 'TLSv1.2' }, anwendung) : http.createServer(anwendung);
    server.headersTimeout = 15_000;
    server.requestTimeout = 30_000;
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(server); });
  });
}
