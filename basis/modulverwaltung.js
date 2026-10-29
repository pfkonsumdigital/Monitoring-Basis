import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ladeModule } from './module.js';
import { berechneAnsicht, leseStatus } from './modulansicht.js';
import { ansicht as einstellungsAnsicht, passwoerter, schreibeAtomar, speichern as einstellungenSpeichern, wirksameWerte } from './einstellungen.js';
import { melde } from './protokoll.js';
import { beendeLaufendeModule } from './ausfuehrung.js';
import { DienstFehler, Dienststeuerung } from './dienste.js';

export const STATUS_DATEI = 'status.json';
export const BEFEHL_DATEI = 'befehl.json';
const FEHLVERSUCHE_BIS_MELDUNG = 4;

// Kennt alle Module, liest neue/geänderte Module ohne Neustart ein, übernimmt die status.json
// eigenständiger Module in den Verlauf und verwaltet Einstellungen und „aktiv“ (Pause).
// Ein fehlerhaftes Modul betrifft immer nur sich selbst.
export class Modulverwaltung {
  constructor({ moduleOrdner, datenOrdner, speicher, planer, uebernehmen, nachTakt = null, dienste = new Dienststeuerung(), abbrechen = beendeLaufendeModule, geheimnisse = [], log = () => {}, jetzt = () => Date.now(), intervallMs = 15_000 }) {
    Object.assign(this, { moduleOrdner, speicher, planer, uebernehmen, nachTakt, dienste, abbrechen, geheimnisse, log, jetzt, intervallMs });
    this.dienstZustand = new Map();
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
    await this.dienstePruefen();
    this.timer = setInterval(() => this.takt(), this.intervallMs);
    this.timer.unref?.();
  }

  stop() { clearInterval(this.timer); }

  async takt() {
    if (this.beschaeftigt) return;
    this.beschaeftigt = true;
    try { await this.einlesen(); await this.statusLesen(); await this.dienstePruefen(); await this.nachTakt?.(this.ansichten()); }
    catch (fehler) { melde(this.log, 'fehler', 'Module', `Module konnten nicht gelesen werden: ${fehler.message}`, fehler); }
    finally { this.beschaeftigt = false; }
  }

  aktiv(modul) { return this.zustand[modul.id]?.aktiv ?? modul.aktiv; }

  // Führt arbeit aus, während kein Takt läuft (z. B. Austausch eines Modulordners beim Update).
  async gesperrt(arbeit) {
    while (this.beschaeftigt) await new Promise((r) => setTimeout(r, 50));
    this.beschaeftigt = true;
    try { return await arbeit(); } finally { this.beschaeftigt = false; }
  }

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
    for (const id of [...this.signaturen.keys()]) if (!ids.has(id)) { this.signaturen.delete(id); this.statusMerker.delete(id); this.dienstZustand.delete(id); }
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
      // Ein beendetes Modul, das sich danach wieder meldet, läuft wieder.
      const beendet = this.zustand[m.id]?.beendet;
      if (beendet && Date.parse(eintrag.ende) > Date.parse(beendet.zeit)) {
        await this.zustandAendern(m.id, { beendet: null });
        this.log(`Modul ${m.id} meldet sich wieder und gilt nicht mehr als beendet.`);
      }
    }
  }

  // Fragt den Zustand der Windows-Dienste ab, die Module in module.json angeben.
  async dienstePruefen() {
    const mitDienst = this.module.filter((m) => !m.fehler && m.dienst);
    await Promise.all(mitDienst.map(async (m) => {
      const neu = await this.dienste.zustand(m.dienst);
      const alt = this.dienstZustand.get(m.id);
      this.dienstZustand.set(m.id, neu);
      if (alt && alt.zustand !== neu.zustand && !['startet', 'stoppt', 'unbekannt'].includes(neu.zustand)) {
        this.log(`Windows-Dienst ${m.dienst} (Modul ${m.id}): ${neu.zustand}.`);
      }
    }));
  }

  async zustandAendern(id, aenderung) {
    const neu = { ...this.zustand[id], ...aenderung };
    for (const k of Object.keys(neu)) if (neu[k] === null || neu[k] === undefined) delete neu[k];
    this.zustand = { ...this.zustand, [id]: neu };
    await schreibeAtomar(this.zustandDatei, this.zustand);
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
      beendet: this.zustand[m.id]?.beendet ?? null,
      dienst: this.dienstZustand.get(m.id) ?? null,
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
    await this.zustandAendern(id, { aktiv });
    this.log(`Modul ${id} ${aktiv ? 'fortgesetzt' : 'pausiert'} durch ${benutzer}.`);
    this.planer?.setzeModule(this.planbar());
    return true;
  }

  // Beendet ein Modul. Eigenständig: Windows-Dienst stoppen bzw. befehl.json schreiben und als „beendet“ merken
  // (keine Alarme, bis es sich wieder meldet). Von der Basis gestartet: laufende Prüfung abbrechen und pausieren.
  // Liefert { ok: true, text } oder { fehler } bzw. null, wenn das Modul unbekannt ist.
  async beenden(id, benutzer) {
    const m = this.finde(id);
    if (!m || m.fehler) return null;
    if (m.typ !== 'eigenstaendig') {
      // Erst pausieren, dann abbrechen – sonst plant der Planer nach dem Abbruch den nächsten Lauf.
      await this.zustandAendern(id, { aktiv: false });
      this.planer?.setzeModule(this.planbar());
      const abgebrochen = this.abbrechen(id);
      const text = `Modul ${id} beendet durch ${benutzer}${abgebrochen ? ' (laufende Prüfung abgebrochen)' : ''}, pausiert.`;
      this.log(text);
      return { ok: true, text };
    }
    if (!m.dienst && !m.befehlsdatei) return { fehler: 'Dieses Modul gibt in module.json nicht an, wie es beendet werden kann („dienst“ oder „befehlsdatei“).' };
    const zeit = new Date(this.jetzt()).toISOString();
    let wie;
    if (m.dienst) {
      try { await this.dienste.beenden(m.dienst); }
      catch (fehler) {
        if (!(fehler instanceof DienstFehler)) throw fehler;
        melde(this.log, 'fehler', `Modul ${id}`, `Windows-Dienst ${m.dienst} konnte nicht beendet werden: ${fehler.message}`);
        return { fehler: fehler.message };
      }
      wie = `Windows-Dienst „${m.dienst}“ gestoppt`;
    } else {
      await schreibeAtomar(path.join(m.ordner, BEFEHL_DATEI), { befehl: 'beenden', zeit, von: benutzer });
      wie = 'Befehl zum Beenden in befehl.json abgelegt';
    }
    await this.zustandAendern(id, { beendet: { zeit, von: benutzer } });
    if (m.dienst) await this.dienstePruefen();
    const text = `Modul ${id} beendet durch ${benutzer} (${wie}).`;
    this.log(text);
    return { ok: true, text };
  }

  // Startet den in module.json eingetragenen Windows-Dienst eines eigenständigen Moduls.
  async starten(id, benutzer) {
    const m = this.finde(id);
    if (!m || m.fehler) return null;
    if (m.typ !== 'eigenstaendig' || !m.dienst) return { fehler: 'Nur Module mit eingetragenem Windows-Dienst („dienst“ in module.json) können über die Basis gestartet werden.' };
    try { await this.dienste.starten(m.dienst); }
    catch (fehler) {
      if (!(fehler instanceof DienstFehler)) throw fehler;
      melde(this.log, 'fehler', `Modul ${id}`, `Windows-Dienst ${m.dienst} konnte nicht gestartet werden: ${fehler.message}`);
      return { fehler: fehler.message };
    }
    await this.zustandAendern(id, { beendet: null });
    await this.dienstePruefen();
    const text = `Modul ${id} gestartet durch ${benutzer} (Windows-Dienst „${m.dienst}“).`;
    this.log(text);
    return { ok: true, text };
  }

  // Beim Beenden der Basis: alle eigenständigen Module beenden, die das unterstützen und noch laufen.
  // Liefert die Liste der Fehlermeldungen (leer = alles beendet).
  async alleBeenden(benutzer) {
    const fehler = [];
    for (const m of this.module) {
      if (m.fehler || m.typ !== 'eigenstaendig' || !(m.dienst || m.befehlsdatei) || this.zustand[m.id]?.beendet) continue;
      try {
        const ergebnis = await this.beenden(m.id, benutzer);
        if (ergebnis?.fehler) fehler.push(`${m.name}: ${ergebnis.fehler}`);
      } catch (f) {
        fehler.push(`${m.name}: ${f.message}`);
      }
    }
    return fehler;
  }
}
