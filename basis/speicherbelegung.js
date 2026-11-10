import { lstat, readdir, rm, statfs } from 'node:fs/promises';
import path from 'node:path';

// Speicherbelegung für Admins: wie viel Platz Basis, Daten und jedes Modul auf dem Worker belegen.
// Gerechnet wird nur auf Anforderung (Ergebnis 5 Minuten zwischengespeichert), Verknüpfungen und
// Junctions werden nicht verfolgt, Dateizahl und Zeit sind begrenzt.

const CACHE_MS = 5 * 60_000;
const MAX_DATEIEN = 200_000;
const MAX_ZEIT_MS = 20_000;

// Größe eines Ordners (oder einer Datei). budget: { dateien, bis } gemeinsam für eine Berechnung.
// Liefert { bytes, dateien, unvollstaendig, unlesbar: [Pfade] }.
export async function groesse(ziel, budget, jetzt = Date.now) {
  const ergebnis = { bytes: 0, dateien: 0, unvollstaendig: false, unlesbar: [] };
  let info;
  try { info = await lstat(ziel); } catch (fehler) {
    if (fehler.code !== 'ENOENT') ergebnis.unlesbar.push(ziel);
    return ergebnis;
  }
  if (info.isSymbolicLink()) return ergebnis;
  if (!info.isDirectory()) { ergebnis.bytes = info.size; ergebnis.dateien = 1; budget.dateien -= 1; return ergebnis; }
  const stapel = [ziel];
  while (stapel.length) {
    if (budget.dateien <= 0 || jetzt() > budget.bis) { ergebnis.unvollstaendig = true; break; }
    const ordner = stapel.pop();
    let eintraege;
    try { eintraege = await readdir(ordner, { withFileTypes: true }); } catch { ergebnis.unlesbar.push(ordner); continue; }
    for (const e of eintraege) {
      const voll = path.join(ordner, e.name);
      // Verknüpfungen (unter Windows auch Junctions) nicht verfolgen und nicht zählen.
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { stapel.push(voll); continue; }
      if (budget.dateien <= 0) { ergebnis.unvollstaendig = true; break; }
      try { ergebnis.bytes += (await lstat(voll)).size; ergebnis.dateien += 1; budget.dateien -= 1; }
      catch { ergebnis.unlesbar.push(voll); }
    }
  }
  return ergebnis;
}

const ROTIERT = /^(basis|fehler)\.log\.\d+$/;

export class Speicherbelegung {
  // module(): [{ id, name }] der bekannten Module (Name für die Anzeige).
  constructor({ installOrdner, datenOrdner, moduleOrdner, logOrdner, module = () => [], log = () => {}, jetzt = Date.now,
    statfsImpl = statfs, maxDateien = MAX_DATEIEN, maxZeitMs = MAX_ZEIT_MS, cacheMs = CACHE_MS }) {
    Object.assign(this, { installOrdner, datenOrdner, moduleOrdner, logOrdner, module, log, jetzt, statfsImpl, maxDateien, maxZeitMs, cacheMs });
    this.letzter = null;
    this.laufend = null;
  }

  // Bericht aus dem Zwischenspeicher oder neu berechnet (neu = true erzwingt die Berechnung).
  async bericht({ neu = false } = {}) {
    if (!neu && this.letzter && this.jetzt() - this.letzter.zeit < this.cacheMs) return this.letzter.bericht;
    // Gleichzeitige Anfragen teilen sich eine Berechnung.
    this.laufend ??= this.berechnen().then((bericht) => { this.letzter = { zeit: this.jetzt(), bericht }; return bericht; })
      .finally(() => { this.laufend = null; });
    return this.laufend;
  }

  vergessen() { this.letzter = null; }

  async berechnen() {
    const start = this.jetzt();
    const budget = { dateien: this.maxDateien, bis: start + this.maxZeitMs };
    const unlesbar = [];
    let unvollstaendig = false;
    const messen = async (ziel) => {
      const r = await groesse(ziel, budget, this.jetzt);
      unlesbar.push(...r.unlesbar);
      if (r.unvollstaendig) unvollstaendig = true;
      return r.bytes;
    };
    const inhalt = async (ordner) => { try { return await readdir(ordner, { withFileTypes: true }); } catch { return []; } };
    const drin = (ordner) => { const rel = path.relative(this.installOrdner, ordner); return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel); };

    // Module: Ordner, Verlauf (data/ergebnisse/<id>.json), alte Versionen (data/modul-versionen/<id>).
    const namen = new Map(this.module().map((m) => [m.id, m.name ?? m.id]));
    const module = [];
    let sonstigeModulordner = 0;
    for (const e of await inhalt(this.moduleOrdner)) {
      const voll = path.join(this.moduleOrdner, e.name);
      if (!e.isDirectory()) { sonstigeModulordner += await messen(voll); continue; }
      const versionenOrdner = path.join(this.datenOrdner, 'modul-versionen', e.name);
      const versionen = (await inhalt(versionenOrdner)).filter((v) => v.isDirectory()).length;
      const m = {
        id: e.name, name: namen.get(e.name) ?? e.name,
        ordner: await messen(voll),
        verlauf: await messen(path.join(this.datenOrdner, 'ergebnisse', `${e.name}.json`)),
        versionen: await messen(versionenOrdner), versionenAnzahl: versionen,
      };
      m.summe = m.ordner + m.verlauf + m.versionen;
      module.push(m);
    }
    module.sort((a, b) => b.summe - a.summe || a.name.localeCompare(b.name, 'de'));

    // Basis.
    const versionenOrdner = path.join(this.installOrdner, 'versionen');
    const programmVersionen = (await inhalt(versionenOrdner)).filter((v) => v.isDirectory() && !v.name.startsWith('.')).length;
    let archiv = 0;
    for (const e of await inhalt(this.logOrdner)) if (e.isFile() && ROTIERT.test(e.name)) archiv += await messen(path.join(this.logOrdner, e.name));
    const daten = await messen(this.datenOrdner);
    const modulDaten = module.reduce((s, m) => s + m.verlauf + m.versionen, 0);
    const basis = [
      { teil: 'versionen', bytes: await messen(versionenOrdner), anzahl: programmVersionen },
      { teil: 'runtime', bytes: await messen(path.join(this.installOrdner, 'runtime')) },
      { teil: 'logs', bytes: await messen(this.logOrdner), archiv },
      { teil: 'daten', bytes: Math.max(0, daten - modulDaten) },
    ];
    // Alles Übrige im Installationsordner (Start.exe, config.json, Sicherungen …).
    const bekannt = new Set([versionenOrdner, path.join(this.installOrdner, 'runtime'), this.logOrdner, this.datenOrdner, this.moduleOrdner].map((p) => path.resolve(p)));
    let sonstiges = sonstigeModulordner;
    for (const e of await inhalt(this.installOrdner)) {
      const voll = path.resolve(this.installOrdner, e.name);
      if (!bekannt.has(voll)) sonstiges += await messen(voll);
    }
    basis.push({ teil: 'sonstiges', bytes: sonstiges });

    const gesamt = basis.reduce((s, b) => s + b.bytes, 0) + module.reduce((s, m) => s + m.summe, 0);
    let laufwerk = null;
    try {
      const f = await this.statfsImpl(this.installOrdner);
      laufwerk = { gesamt: f.blocks * f.bsize, frei: f.bavail * f.bsize };
    } catch { /* nicht verfügbar */ }
    return {
      berechnet: new Date(this.jetzt()).toISOString(), dauerMs: this.jetzt() - start, gesamt, laufwerk, basis, module,
      unvollstaendig, unlesbar: unlesbar.slice(0, 20).map((p) => (drin(p) ? path.relative(this.installOrdner, p) : p)), unlesbarAnzahl: unlesbar.length,
    };
  }

  // Rotierte Protokolldateien (basis.log.N, fehler.log.N) löschen. Die aktuellen Dateien bleiben.
  async protokollArchivLoeschen(benutzer) {
    let geloescht = 0, bytes = 0;
    for (const e of await readdir(this.logOrdner, { withFileTypes: true }).catch(() => [])) {
      if (!e.isFile() || !ROTIERT.test(e.name)) continue;
      const voll = path.join(this.logOrdner, e.name);
      try { const g = (await lstat(voll)).size; await rm(voll); geloescht += 1; bytes += g; } catch { /* in Benutzung oder schon weg */ }
    }
    this.vergessen();
    this.log(`Protokoll-Archiv gelöscht durch ${benutzer}: ${geloescht} Datei(en), ${bytes} Bytes.`);
    return { geloescht, bytes };
  }
}
