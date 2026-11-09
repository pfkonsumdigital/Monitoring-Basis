import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { schreibeAtomar } from './einstellungen.js';
import { melde } from './protokoll.js';

// Freigabe ausführbarer Module durch einen Admin.
// Die Basis führt „programm“- und „plugin“-Module als SYSTEM aus und steuert eingetragene Windows-Dienste.
// Ein Modul läuft nur, wenn sein aktueller Fingerabdruck (Befehl, Argumente, Prüfsummen aller Dateien im Modulordner
// und der aufgerufenen Programmdatei) dem zuletzt von einem Admin freigegebenen entspricht. Jede Änderung –
// auch eine einzelne Datei – stoppt das Modul, bis ein Admin die angezeigten Änderungen freigibt.

export const FREIGABE_DATEI = 'modulfreigaben.json';
export const MAX_DATEIEN = 5000;
export const MAX_BYTES = 500 * 1024 * 1024;
// Dateien, die die Basis bzw. das Modul im Betrieb selbst schreibt, und Ordner für Daten und Protokolle.
// module.json fließt nicht als Datei ein, sondern über die ausgewerteten Angaben (typ, befehl, argumente …):
// Name, Intervall oder Beschreibung zu ändern, braucht so keine neue Freigabe.
const OBEN_AUSGENOMMEN = new Set(['module.json', 'status.json', 'einstellungen.json', 'befehl.json']);
const ORDNER_AUSGENOMMEN = new Set(['daten', 'logs']);
const ENDUNGEN = ['', '.exe', '.com', '.cmd', '.bat'];

export class FreigabeFehler extends Error {}

// Braucht dieses Modul eine Freigabe? Alles, was die Basis ausführt oder steuert.
export function braucht(m) {
  if (!m || m.fehler) return false;
  if (m.typ === 'programm' || m.typ === 'plugin') return true;
  return m.typ === 'eigenstaendig' && Boolean(m.dienst);
}

const innerhalb = (wurzel, ziel) => {
  const rel = path.relative(wurzel, ziel);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};
const mb = (bytes) => `${Math.round(bytes / 1024 / 1024)} MB`;
const relativ = (wurzel, ziel) => path.relative(wurzel, ziel).split(path.sep).join('/') || '.';

async function pruefsumme(datei, info, cache) {
  const schluessel = `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  const bekannt = cache?.alt.get(datei);
  if (bekannt && bekannt.schluessel === schluessel) {
    cache.neu.set(datei, bekannt);
    return bekannt.wert;
  }
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    createReadStream(datei).on('data', (t) => hash.update(t)).on('end', resolve).on('error', reject);
  });
  const wert = hash.digest('hex');
  cache?.neu.set(datei, { schluessel, wert });
  return wert;
}

// Prüfsummen aller Dateien im Modulordner (rekursiv, sortiert). Verknüpfungen (Symlinks, Junctions) sind nicht erlaubt,
// weil sie auf Dateien außerhalb zeigen könnten, die so unbemerkt geändert würden.
async function ordnerPruefsummen(ordner, zaehler, cache, grenzen) {
  const dateien = {};
  const durchlaufen = async (verzeichnis, tiefe) => {
    if (tiefe > 32) throw new FreigabeFehler('Der Modulordner ist zu tief verschachtelt.');
    const eintraege = (await readdir(verzeichnis, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of eintraege) {
      const voll = path.join(verzeichnis, e.name);
      const rel = relativ(ordner, voll);
      if (tiefe === 0 && e.isFile() && OBEN_AUSGENOMMEN.has(e.name.toLowerCase())) continue;
      if (tiefe === 0 && e.isDirectory() && ORDNER_AUSGENOMMEN.has(e.name.toLowerCase())) continue;
      if (e.isFile() && e.name.toLowerCase().endsWith('.tmp')) continue;
      if (e.isSymbolicLink()) throw new FreigabeFehler(`Der Modulordner enthält eine Verknüpfung (${rel}). Verknüpfungen sind nicht erlaubt.`);
      if (e.isDirectory()) { await durchlaufen(voll, tiefe + 1); continue; }
      if (!e.isFile()) throw new FreigabeFehler(`Der Modulordner enthält einen unbekannten Eintrag (${rel}).`);
      const info = await lstat(voll);
      if (!info.isFile()) throw new FreigabeFehler(`Der Modulordner enthält eine Verknüpfung (${rel}). Verknüpfungen sind nicht erlaubt.`);
      zaehler.dateien++;
      zaehler.bytes += info.size;
      if (zaehler.dateien > grenzen.dateien) throw new FreigabeFehler(`Der Modulordner enthält mehr als ${grenzen.dateien} Dateien.`);
      if (zaehler.bytes > grenzen.bytes) throw new FreigabeFehler(`Der Modulordner ist größer als ${mb(grenzen.bytes)}.`);
      dateien[rel] = await pruefsumme(voll, info, cache);
    }
  };
  await durchlaufen(ordner, 0);
  return dateien;
}

// Dateien außerhalb des Modulordners, die beim Start ausgeführt bzw. gelesen werden: die Programmdatei („befehl“)
// und Argumente, die auf vorhandene Dateien zeigen. Ein reiner Programmname (z. B. „python“) wird unter Windows
// zuerst im Arbeitsordner gesucht – daher werden dort liegende Dateien dieses Namens ebenfalls erfasst.
async function externeDateien(m, zaehler, cache, grenzen) {
  const kandidaten = new Set();
  const befehl = m.befehl;
  if (/[\\/]/.test(befehl) || path.isAbsolute(befehl)) kandidaten.add(path.resolve(m.arbeitsordner, befehl));
  else for (const endung of ENDUNGEN) kandidaten.add(path.resolve(m.arbeitsordner, befehl + endung));
  for (const a of (m.argumente ?? []).slice(0, 50)) if (a && a.length <= 1000 && !a.startsWith('-')) kandidaten.add(path.resolve(m.arbeitsordner, a));
  const extern = {};
  for (const datei of [...kandidaten].sort()) {
    if (innerhalb(m.ordner, datei)) continue; // im Modulordner: schon erfasst
    let info;
    try { info = await stat(datei); } catch { continue; }
    if (!info.isFile()) continue;
    zaehler.bytes += info.size;
    if (zaehler.bytes > grenzen.bytes) throw new FreigabeFehler(`Die Dateien des Moduls sind zusammen größer als ${mb(grenzen.bytes)}.`);
    extern[datei] = await pruefsumme(datei, info, cache);
  }
  return extern;
}

// Fingerabdruck eines Moduls: { wert, angaben } oder { wert: null, fehler }.
// cache ({ alt, neu } aus Maps) nur für die regelmäßige Anzeige; vor jedem Start und beim Freigeben ohne Cache.
export async function fingerabdruck(m, { cache = null, grenzen = { dateien: MAX_DATEIEN, bytes: MAX_BYTES } } = {}) {
  try {
    if (m.typ === 'eigenstaendig') return mitWert({ typ: m.typ, dienst: m.dienst ?? null });
    const ordnerInfo = await lstat(m.ordner).catch(() => null);
    if (!ordnerInfo?.isDirectory()) throw new FreigabeFehler('Der Modulordner ist eine Verknüpfung oder fehlt.');
    const zaehler = { dateien: 0, bytes: 0 };
    const angaben = { typ: m.typ };
    if (m.typ === 'programm') {
      angaben.befehl = m.befehl;
      angaben.argumente = [...(m.argumente ?? [])];
      angaben.arbeitsordner = innerhalb(m.ordner, m.arbeitsordner) ? relativ(m.ordner, m.arbeitsordner) : m.arbeitsordner;
    } else {
      angaben.einstieg = relativ(m.ordner, m.einstieg);
    }
    angaben.dateien = await ordnerPruefsummen(m.ordner, zaehler, cache, grenzen);
    angaben.extern = m.typ === 'programm' ? await externeDateien(m, zaehler, cache, grenzen) : {};
    return mitWert(angaben);
  } catch (fehler) {
    if (fehler instanceof FreigabeFehler) return { wert: null, fehler: fehler.message };
    return { wert: null, fehler: `Der Modulordner konnte nicht vollständig gelesen werden (${fehler.code ?? fehler.message}).` };
  }
}

function mitWert(angaben) {
  return { wert: createHash('sha256').update(JSON.stringify(angaben)).digest('hex'), angaben };
}

// Lesbare Liste der Änderungen gegenüber der letzten Freigabe (höchstens max Einträge).
export function unterschiede(alt, neu, max = 50) {
  if (!neu) return [];
  if (!alt) {
    const anzahl = Object.keys(neu.dateien ?? {}).length;
    return [neu.typ === 'eigenstaendig'
      ? `Neues Modul: steuert den Windows-Dienst „${neu.dienst}“.`
      : `Neues Modul (${neu.typ}${neu.befehl ? `, Befehl „${neu.befehl}“` : ''}${neu.einstieg ? `, Einstieg „${neu.einstieg}“` : ''}, ${anzahl} Datei${anzahl === 1 ? '' : 'en'}).`];
  }
  const liste = [];
  const text = (w) => (w === undefined || w === null ? '–' : typeof w === 'string' ? `„${w}“` : JSON.stringify(w));
  for (const k of ['typ', 'dienst', 'befehl', 'argumente', 'arbeitsordner', 'einstieg']) {
    if (JSON.stringify(alt[k]) !== JSON.stringify(neu[k])) liste.push(`${k}: ${text(alt[k])} → ${text(neu[k])}`);
  }
  for (const [art, a, n] of [['', alt.dateien ?? {}, neu.dateien ?? {}], ['Datei außerhalb des Modulordners ', alt.extern ?? {}, neu.extern ?? {}]]) {
    for (const d of Object.keys(n)) {
      if (!Object.hasOwn(a, d)) liste.push(`${art}neu: ${d}`);
      else if (a[d] !== n[d]) liste.push(`${art}geändert: ${d}`);
    }
    for (const d of Object.keys(a)) if (!Object.hasOwn(n, d)) liste.push(`${art}entfernt: ${d}`);
  }
  if (!liste.length) liste.push('Keine inhaltliche Änderung erkennbar (andere Fassung der Angaben).');
  return liste.length > max ? [...liste.slice(0, max), `… und ${liste.length - max} weitere Änderungen`] : liste;
}

// Gespeicherte Freigaben (data/modulfreigaben.json): je Modul der freigegebene Fingerabdruck mit Angaben, Zeit und Admin.
export class Freigaben {
  constructor({ datenOrdner, log = () => {}, jetzt = () => Date.now() }) {
    this.datei = path.join(datenOrdner, FREIGABE_DATEI);
    this.log = log;
    this.jetzt = jetzt;
    this.module = {};
    this.ersterStart = false;
  }

  async laden() {
    let text;
    try { text = await readFile(this.datei, 'utf8'); }
    catch (fehler) {
      if (fehler.code !== 'ENOENT') throw fehler;
      // Erster Start mit Freigaben (Update auf 0.15.0): bestehende Module werden einmalig übernommen.
      this.ersterStart = true;
      this.module = {};
      return;
    }
    try {
      const roh = JSON.parse(text);
      if (roh?.version !== 1 || !roh.module || typeof roh.module !== 'object' || Array.isArray(roh.module)) throw new Error('Format');
      const module = {};
      for (const [id, e] of Object.entries(roh.module)) {
        if (/^[a-z0-9][a-z0-9-]{0,62}$/.test(id) && typeof e?.wert === 'string' && /^[0-9a-f]{64}$/.test(e.wert)) module[id] = e;
      }
      this.module = module;
    } catch {
      // Beschädigt: nichts gilt als freigegeben (sicherer Zustand). Ein Admin gibt die Module neu frei.
      this.module = {};
      melde(this.log, 'fehler', 'Sicherheit', `${FREIGABE_DATEI} ist beschädigt. Alle ausführbaren Module müssen von einem Admin neu freigegeben werden.`);
    }
  }

  eintrag(id) { return Object.hasOwn(this.module, id) ? this.module[id] : null; }
  wert(id) { return this.eintrag(id)?.wert ?? null; }

  // liste: [{ id, wert, angaben }]
  async setzen(liste, von, grund) {
    const zeit = new Date(this.jetzt()).toISOString();
    const neu = { ...this.module };
    for (const { id, wert, angaben } of liste) neu[id] = { wert, angaben, zeit, von, grund };
    await schreibeAtomar(this.datei, { version: 1, module: neu });
    this.module = neu;
    this.ersterStart = false;
  }
}
