import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

export const STUFEN = ['info', 'warnung', 'fehler'];
const MAX_DETAILS = 8000;

// Entfernt bekannte Geheimnisse und typische Token-Formate aus Protokolltexten.
export function bereinige(text, geheimnisse = []) {
  let s = String(text ?? '');
  for (const g of geheimnisse) if (typeof g === 'string' && g.length >= 6) s = s.split(g).join('***');
  return s
    .replace(/\b(github_pat_|ghp_|gho_|ghs_)[A-Za-z0-9_]{10,}/g, '***')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***')
    .replace(/scrypt\$[^\s"']+/g, 'scrypt$***')
    .replace(/((?:passwort|password|token|secret)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1***');
}

// Protokoll mit drei Stufen. basis.log enthält alles als lesbaren Text, fehler.log zusätzlich
// alle Warnungen und Fehler als JSON-Zeilen (für die Ansicht in der Oberfläche).
// Jede Datei wird ab maxBytes rotiert; es bleiben maxDateien ältere Dateien erhalten.
export class Protokoll {
  constructor({ ordner, geheimnisse = [], maxBytes = 5 * 1024 * 1024, maxDateien = 5, konsole = true, jetzt = () => new Date() }) {
    this.ordner = ordner;
    this.geheimnisse = geheimnisse;
    this.maxBytes = maxBytes;
    this.maxDateien = maxDateien;
    this.konsole = konsole;
    this.jetzt = jetzt;
    mkdirSync(ordner, { recursive: true });
    this.basisDatei = path.join(ordner, 'basis.log');
    this.fehlerDatei = path.join(ordner, 'fehler.log');
  }

  rotieren(datei, zusatz) {
    let groesse = 0;
    try { groesse = statSync(datei).size; } catch { return; }
    if (groesse + zusatz <= this.maxBytes) return;
    rmSync(`${datei}.${this.maxDateien}`, { force: true });
    for (let i = this.maxDateien - 1; i >= 1; i--) if (existsSync(`${datei}.${i}`)) renameSync(`${datei}.${i}`, `${datei}.${i + 1}`);
    renameSync(datei, `${datei}.1`);
  }

  schreiben(datei, zeile) {
    try {
      this.rotieren(datei, Buffer.byteLength(zeile));
      appendFileSync(datei, zeile);
    } catch { /* Das Protokoll darf die Basis nie zum Absturz bringen. */ }
  }

  eintrag(stufe, quelle, meldung, details) {
    const zeit = this.jetzt().toISOString();
    const text = bereinige(meldung, this.geheimnisse).replace(/[\r\n]+/g, ' ').slice(0, 2000);
    const detailText = details === undefined || details === null || details === '' ? undefined
      : bereinige(details instanceof Error ? (details.stack || details.message) : details, this.geheimnisse).slice(0, MAX_DETAILS);
    const zeile = `${zeit} ${stufe === 'info' ? '' : `[${stufe.toUpperCase()}] `}${quelle ? `[${quelle}] ` : ''}${text}`;
    if (this.konsole) (stufe === 'info' ? console.log : console.error)(zeile);
    this.schreiben(this.basisDatei, zeile + (detailText ? `\n    ${detailText.replace(/\n/g, '\n    ')}` : '') + '\n');
    if (stufe !== 'info') this.schreiben(this.fehlerDatei, JSON.stringify({ zeit, stufe, quelle: quelle || 'Basis', meldung: text, ...(detailText ? { details: detailText } : {}) }) + '\n');
  }

  info(quelle, meldung, details) { this.eintrag('info', quelle, meldung, details); }
  warnung(quelle, meldung, details) { this.eintrag('warnung', quelle, meldung, details); }
  fehler(quelle, meldung, details) { this.eintrag('fehler', quelle, meldung, details); }

  // Einfache Funktion log(text) für Komponenten, die nur Infos schreiben – mit Stufen-Methoden daran.
  alsFunktion(quelle = 'Basis') {
    const log = (text) => this.info(quelle, text);
    log.info = (q, m, d) => this.info(q, m, d);
    log.warnung = (q, m, d) => this.warnung(q, m, d);
    log.fehler = (q, m, d) => this.fehler(q, m, d);
    return log;
  }

  // Neueste Warnungen/Fehler zuerst, optional gefiltert. Liest fehler.log und rotierte Dateien.
  lesen({ anzahl = 200, stufe, quelle } = {}) {
    const ergebnis = [];
    for (let i = 0; i <= this.maxDateien && ergebnis.length < anzahl; i++) {
      const datei = i === 0 ? this.fehlerDatei : `${this.fehlerDatei}.${i}`;
      let text;
      try { text = readFileSync(datei, 'utf8'); } catch { continue; }
      const zeilen = text.split('\n').filter(Boolean).reverse();
      for (const z of zeilen) {
        let e;
        try { e = JSON.parse(z); } catch { continue; }
        if (stufe && e.stufe !== stufe) continue;
        if (quelle && !String(e.quelle).startsWith(quelle)) continue;
        ergebnis.push(e);
        if (ergebnis.length >= anzahl) break;
      }
    }
    return ergebnis;
  }
}

// Meldet mit Stufe, wenn das übergebene log Stufen kennt, sonst als einfacher Text.
export function melde(log, stufe, quelle, meldung, details) {
  if (typeof log?.[stufe] === 'function') log[stufe](quelle, meldung, details);
  else if (typeof log === 'function') log(`${stufe === 'info' ? '' : `${stufe.toUpperCase()}: `}${quelle ? `${quelle}: ` : ''}${meldung}`);
}
