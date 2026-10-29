import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ladeModule } from './module.js';
import { berechneAnsicht, leseStatus } from './modulansicht.js';
import { ansicht as einstellungsAnsicht, passwoerter, schreibeAtomar, speichern as einstellungenSpeichern, wirksameWerte } from './einstellungen.js';
import { melde } from './protokoll.js';

export const STATUS_DATEI = 'status.json';
const FEHLVERSUCHE_BIS_MELDUNG = 4;

// Kennt alle Module, liest neue/geänderte Module ohne Neustart ein, übernimmt die status.json
// eigenständiger Module in den Verlauf und verwaltet Einstellungen und „aktiv“ (Pause).
// Ein fehlerhaftes Modul betrifft immer nur sich selbst.
export class Modulverwaltung {
  constructor({ moduleOrdner, datenOrdner, speicher, planer, uebernehmen, geheimnisse = [], log = () => {}, jetzt = () => Date.now(), intervallMs = 15_000 }) {
    Object.assign(this, { moduleOrdner, speicher, planer, uebernehmen, geheimnisse, log, jetzt, intervallMs });
    this.zustandDatei = path.join(datenOrdner, 'modulzustand.json');
    this.module = [];
    this.signaturen = new Map();
    this.erkannt = new Map();
    this.statusMerker = new Map();
    this.zustand = {};
  }

  async start() {
    try { this.zustand = JSON.parse(await readFile(this.zustandDatei, 'utf8')) ?? {}; } catch { this.zustand = {}; }
    await this.einlesen();
    await this.statusLesen();
    this.timer = setInterval(() => this.takt(), this.intervallMs);
    this.timer.unref?.();
  }

  stop() { clearInterval(this.timer); }

  async takt() {
    if (this.beschaeftigt) return;
    this.beschaeftigt = true;
    try { await this.einlesen(); await this.statusLesen(); }
    catch (fehler) { melde(this.log, 'fehler', 'Module', `Module konnten nicht gelesen werden: ${fehler.message}`, fehler); }
    finally { this.beschaeftigt = false; }
  }

  aktiv(modul) { return this.zustand[modul.id]?.aktiv ?? modul.aktiv; }

  // Liest den Modulordner neu ein und meldet Änderungen.
  async einlesen() {
    const neu = await ladeModule(this.moduleOrdner);
    const ids = new Set(neu.map((m) => m.id));
    for (const alt of this.module) if (!ids.has(alt.id)) this.log(`Modul ${alt.id} wurde entfernt.`);
    for (const m of neu) {
      const signatur = JSON.stringify(m);
      const bekannt = this.signaturen.get(m.id);
      if (bekannt === signatur) continue;
      this.signaturen.set(m.id, signatur);
      if (!this.erkannt.has(m.id)) this.erkannt.set(m.id, new Date(this.jetzt()).toISOString());
      if (m.fehler) melde(this.log, 'fehler', `Modul ${m.name}`, `Modul fehlerhaft: ${m.fehler}`);
      else this.log(`Modul ${m.id} (${m.typ}${m.version ? ` ${m.version}` : ''}) ${bekannt ? 'geändert' : 'geladen'}${this.aktiv(m) ? '' : ', pausiert'}.`);
      if (!m.fehler) {
        await this.speicher.sicherstellen(m.id);
        for (const p of await passwoerter(m)) if (!this.geheimnisse.includes(p)) this.geheimnisse.push(p);
      }
    }
    for (const id of [...this.signaturen.keys()]) if (!ids.has(id)) { this.signaturen.delete(id); this.statusMerker.delete(id); }
    this.module = neu;
    this.planer?.setzeModule(this.planbar());
  }

  planbar() {
    return this.module.map((m) => ({ ...m, aktiv: this.aktiv(m), einstellungenLaden: () => wirksameWerte(m) }));
  }

  // Übernimmt neue Meldungen eigenständiger Module aus deren status.json.
  async statusLesen() {
    for (const m of this.module) {
      if (m.fehler || m.typ !== 'eigenstaendig') continue;
      const merker = this.statusMerker.get(m.id) ?? { fehlversuche: 0, fehler: null };
      this.statusMerker.set(m.id, merker);
      let text;
      try { text = await readFile(path.join(m.ordner, STATUS_DATEI), 'utf8'); }
      catch { merker.fehlversuche = 0; merker.fehler = null; continue; }
      const { eintrag, fehler } = leseStatus(text);
      if (fehler) {
        // Halb geschriebene Datei: beim nächsten Takt erneut versuchen, erst nach mehreren Fehlversuchen melden.
        merker.fehlversuche++;
        if (merker.fehlversuche === FEHLVERSUCHE_BIS_MELDUNG) {
          merker.fehler = fehler;
          melde(this.log, 'warnung', `Modul ${m.id}`, `Meldung des Moduls nicht lesbar: ${fehler}`);
        }
        continue;
      }
      merker.fehlversuche = 0;
      merker.fehler = null;
      const letztes = this.speicher.letztes(m.id);
      if (letztes?.ende === eintrag.ende) continue;
      if (letztes && Date.parse(letztes.ende ?? letztes.beginn) > Date.parse(eintrag.ende)) continue;
      await this.uebernehmen(m.id, eintrag);
    }
  }

  finde(id) { return this.module.find((m) => m.id === id) ?? null; }

  ansicht(m) {
    return berechneAnsicht(m, {
      verlauf: m.fehler ? [] : this.speicher.verlauf(m.id),
      aktiv: this.aktiv(m),
      laeuft: this.planer?.laeuft(m.id) ?? false,
      geplant: this.planer?.naechster(m.id) ?? null,
      erkanntSeit: this.erkannt.get(m.id) ?? null,
      statusFehler: this.statusMerker.get(m.id)?.fehler ?? null,
      jetzt: this.jetzt(),
    });
  }

  ansichten() {
    return this.module.map((m) => this.ansicht(m)).sort((a, b) => a.schwere - b.schwere || a.name.localeCompare(b.name, 'de'));
  }

  verlauf(id, anzahl) { return this.speicher.verlauf(id, anzahl); }

  // 'gestartet' | 'unbekannt' | 'fehlerhaft' | 'eigenstaendig' | 'laeuft'
  jetztPruefen(id) {
    const m = this.finde(id);
    if (!m) return 'unbekannt';
    if (m.fehler) return 'fehlerhaft';
    if (m.typ === 'eigenstaendig') return 'eigenstaendig';
    return this.planer.jetztPruefen(id) ? 'gestartet' : 'laeuft';
  }

  async einstellungen(id) {
    const m = this.finde(id);
    return m && !m.fehler ? einstellungsAnsicht(m) : null;
  }

  async einstellungenAendern(id, eingabe, benutzer) {
    const m = this.finde(id);
    if (!m || m.fehler) return null;
    const ergebnis = await einstellungenSpeichern(m, eingabe);
    if (ergebnis.geaendert?.length) {
      const namen = ergebnis.geaendert.map((k) => m.felder.find((f) => f.schluessel === k)?.bezeichnung ?? k);
      this.log(`Einstellungen von Modul ${id} geändert durch ${benutzer}: ${namen.join(', ')}.`);
      for (const p of await passwoerter(m)) if (!this.geheimnisse.includes(p)) this.geheimnisse.push(p);
    }
    return ergebnis;
  }

  async setzeAktiv(id, aktiv, benutzer) {
    const m = this.finde(id);
    if (!m || m.fehler) return false;
    this.zustand = { ...this.zustand, [id]: { aktiv } };
    await schreibeAtomar(this.zustandDatei, this.zustand);
    this.log(`Modul ${id} ${aktiv ? 'fortgesetzt' : 'pausiert'} durch ${benutzer}.`);
    this.planer?.setzeModule(this.planbar());
    return true;
  }
}
