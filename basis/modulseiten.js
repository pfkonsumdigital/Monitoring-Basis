// Seiten eigenständiger Module (seit 0.21.0).
// Ein Modul mit „seite“ in module.json betreibt einen eigenen Webserver nur auf 127.0.0.1:<port>. Die Basis zeigt
// ihn als Menüpunkt und leitet /m/<id>/… dorthin weiter – erst nach Anmeldung, Zwei-Faktor und Rechteprüfung.
// Dabei schickt sie mit, wer angemeldet ist (x-monitoring-benutzer, -recht, -admin) und den Schlüssel aus der
// Datei „seite.schluessel“, die das Modul beim Start in seinen Ordner schreibt (x-monitoring-schluessel).
// Ohne diesen Schlüssel lehnt das Modul jede Anfrage ab; so kommt niemand an der Basis vorbei.
// Programme (z. B. Claude) rufen /m/<id>/api/… mit „Authorization: Bearer <Schlüssel des Moduls>“ ohne Anmeldung
// auf, wenn das Modul „api“: true angibt. Den Schlüssel prüft das Modul; die Basis bremst Fehlversuche.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { melde } from './protokoll.js';

export const SCHLUESSEL_DATEI = 'seite.schluessel';
const SCHLUESSEL_MUSTER = /^[A-Za-z0-9_-]{32,128}$/;
const MAX_KOERPER = 5 * 1024 * 1024;
const ZEITLIMIT_MS = 30_000;
// Bremse für Programm-Zugänge: nach 10 abgewiesenen Schlüsseln je Adresse 15 Minuten Sperre.
const FEHLVERSUCHE = 10;
const SPERRE_MS = 15 * 60_000;
const ANFRAGE_KOPF = ['accept', 'accept-language', 'content-type', 'content-length', 'if-none-match', 'if-modified-since', 'user-agent', 'x-monitor-hintergrund'];
const ANTWORT_KOPF = ['content-type', 'content-length', 'last-modified', 'etag', 'content-disposition'];

// '/m/tickets/api/x' → { id: 'tickets', rest: '/api/x' }; '/m/tickets' → rest null (Umleitung auf '/m/tickets/').
// Kodierte Schrägstriche, Punkte und Rückstriche werden abgewiesen (rest: false).
export function modulWeg(weg) {
  const t = /^\/m\/([a-z0-9-]{1,64})(\/.*)?$/.exec(weg);
  if (!t) return null;
  const rest = t[2] ?? null;
  if (rest !== null && (/%(2f|5c|2e|00)/i.test(rest) || /[\\\0]/.test(rest) || rest.includes('//'))) return { id: t[1], rest: false };
  return { id: t[1], rest };
}

export const istProgrammAnfrage = (req, mw) => Boolean(mw?.rest && mw.rest.startsWith('/api/') && /^Bearer\s+\S/i.test(req.headers.authorization ?? ''));

const html = (t) => String(t).replace(/[&<>"']/g, (z) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[z]);

export class Modulseiten {
  constructor({ module, log = () => {}, jetzt = () => Date.now(), anfrage = http.request, zeitlimitMs = ZEITLIMIT_MS }) {
    this.module = module;
    this.log = log;
    this.jetzt = jetzt;
    this.anfrage = anfrage;
    this.zeitlimitMs = zeitlimitMs;
    this.schluesselCache = new Map();
    this.fehlversuche = new Map();
    this.nichtErreichbar = new Set();
  }

  // Modul mit eigener Seite – nur fehlerfrei und freigegeben.
  modul(id) {
    const m = typeof this.module?.finde === 'function' ? this.module.finde(id) : null;
    if (!m || m.fehler || !m.seite) return null;
    if (typeof this.module.freigabeNoetig === 'function' && this.module.freigabeNoetig(m)) return null;
    return m;
  }

  // Schlüssel aus <Modulordner>/seite.schluessel (neu gelesen, sobald sich die Datei ändert).
  async schluessel(m) {
    const datei = path.join(m.ordner, SCHLUESSEL_DATEI);
    const info = await stat(datei).catch(() => null);
    if (!info) return null;
    const merker = `${info.mtimeMs}:${info.size}`;
    const alt = this.schluesselCache.get(m.id);
    if (alt?.merker === merker) return alt.wert;
    const wert = (await readFile(datei, 'utf8').catch(() => '')).trim();
    const gueltig = SCHLUESSEL_MUSTER.test(wert) ? wert : null;
    this.schluesselCache.set(m.id, { merker, wert: gueltig });
    return gueltig;
  }

  gesperrt(adresse) {
    const e = this.fehlversuche.get(adresse);
    if (!e) return false;
    if (this.jetzt() - e.seit > SPERRE_MS) { this.fehlversuche.delete(adresse); return false; }
    return e.anzahl >= FEHLVERSUCHE;
  }

  fehlversuch(adresse, m) {
    const e = this.fehlversuche.get(adresse);
    const neu = !e || this.jetzt() - e.seit > SPERRE_MS ? { anzahl: 1, seit: this.jetzt() } : { anzahl: e.anzahl + 1, seit: e.seit };
    if (this.fehlversuche.size < 10_000 || e) this.fehlversuche.set(adresse, neu);
    if (neu.anzahl === FEHLVERSUCHE) melde(this.log, 'warnung', 'Modulseiten', `Programm-Zugang zu ${m.name}: ${FEHLVERSUCHE} abgewiesene Schlüssel von ${adresse} – Adresse für 15 Minuten gesperrt.`);
  }

  // Leitet die Anfrage an das Modul weiter. benutzer: { name, recht, admin } oder null (Programm-Zugang).
  async weiterleiten(req, res, m, { rest, suche = '', benutzer = null, sicherheit = {} }) {
    const fehlerAntwort = (status, text) => {
      const seite = req.method === 'GET' && /text\/html/.test(req.headers.accept ?? '') && benutzer;
      if (seite) {
        res.writeHead(status, { ...sicherheit, 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${html(m.seite.titel)}</title><link rel="stylesheet" href="/style.css"></head><body><main><p class="leer">${html(text)}</p></main></body></html>`);
      }
      res.writeHead(status, { ...sicherheit, 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ fehler: text }));
    };
    const schluessel = await this.schluessel(m);
    if (!schluessel) return fehlerAntwort(503, `${m.seite.titel}: Das Modul läuft gerade nicht oder startet noch (seite.schluessel fehlt).`);

    const kopf = { host: `127.0.0.1:${m.seite.port}`, 'x-monitoring-schluessel': schluessel };
    for (const k of ANFRAGE_KOPF) if (req.headers[k] !== undefined) kopf[k] = req.headers[k];
    if (benutzer) {
      kopf['x-monitoring-zugang'] = 'sitzung';
      kopf['x-monitoring-benutzer'] = encodeURIComponent(benutzer.name);
      kopf['x-monitoring-recht'] = benutzer.recht;
      kopf['x-monitoring-admin'] = benutzer.admin ? '1' : '0';
    } else {
      kopf['x-monitoring-zugang'] = 'programm';
      kopf.authorization = req.headers.authorization;
    }
    const laenge = Number(req.headers['content-length'] ?? 0);
    if (laenge > MAX_KOERPER) return fehlerAntwort(413, 'Die Anfrage ist zu groß.');

    return new Promise((fertig) => {
      let erledigt = false;
      const ende = () => { if (!erledigt) { erledigt = true; fertig(); } };
      const ziel = this.anfrage({ host: '127.0.0.1', port: m.seite.port, method: req.method, path: rest + suche, headers: kopf, timeout: this.zeitlimitMs }, (antwort) => {
        if (this.nichtErreichbar.delete(m.id)) this.log(`Modulseite ${m.name} ist wieder erreichbar.`);
        if (!benutzer && antwort.statusCode === 401) this.fehlversuch(req.socket.remoteAddress, m);
        const aus = { ...sicherheit };
        for (const k of ANTWORT_KOPF) if (antwort.headers[k] !== undefined) aus[k] = antwort.headers[k];
        // Umleitungen nur innerhalb des Moduls: „/x“ wird zu „/m/<id>/x“.
        const ort = antwort.headers.location;
        if (typeof ort === 'string' && ort.startsWith('/') && !ort.startsWith('//')) aus.location = `/m/${m.id}${ort}`;
        else if (typeof ort === 'string' && !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(ort)) aus.location = ort;
        res.writeHead(antwort.statusCode ?? 502, aus);
        antwort.pipe(res);
        antwort.on('end', ende);
        antwort.on('error', () => { res.destroy(); ende(); });
      });
      ziel.on('timeout', () => ziel.destroy(Object.assign(new Error('Zeitlimit'), { code: 'ZEITLIMIT' })));
      ziel.on('error', (fehler) => {
        if (res.headersSent) { res.destroy(); return ende(); }
        if (fehler.code === 'ZEITLIMIT') fehlerAntwort(504, `${m.seite.titel}: Das Modul antwortet nicht.`);
        else {
          if (!this.nichtErreichbar.has(m.id)) {
            this.nichtErreichbar.add(m.id);
            melde(this.log, 'warnung', 'Modulseiten', `Modulseite ${m.name} nicht erreichbar (127.0.0.1:${m.seite.port}): ${fehler.code ?? fehler.message}`);
          }
          fehlerAntwort(502, `${m.seite.titel}: Das Modul läuft gerade nicht. Ein Admin kann es in der Übersicht auf der Kachel des Moduls starten.`);
        }
        ende();
      });
      let gelesen = 0;
      req.on('data', (stueck) => {
        gelesen += stueck.length;
        if (gelesen > MAX_KOERPER) { ziel.destroy(); req.destroy(); return; }
        ziel.write(stueck);
      });
      req.on('end', () => ziel.end());
      req.on('error', () => ziel.destroy());
    });
  }
}
