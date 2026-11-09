import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ladeModule } from './module.js';
import { berechneAnsicht, leseStatus, zeitBegrenzen } from './modulansicht.js';
import { ansicht as einstellungsAnsicht, passwoerter, schreibeAtomar, speichern as einstellungenSpeichern, verschluesseln as einstellungenVerschluesseln, wirksameWerte } from './einstellungen.js';
import { melde } from './protokoll.js';
import { beendeLaufendeModule } from './ausfuehrung.js';
import { DienstFehler, Dienststeuerung } from './dienste.js';
import { leseBegrenzt, STATUS_JSON_MAX } from './dateien.js';
import { braucht, fingerabdruck, unterschiede } from './freigabe.js';

export const STATUS_DATEI = 'status.json';
export const BEFEHL_DATEI = 'befehl.json';
const FEHLVERSUCHE_BIS_MELDUNG = 4;
// Manuelle Prüfung („Jetzt prüfen“) höchstens einmal pro Minute und Modul.
export const MANUELL_ABSTAND_MS = 60_000;
const NICHT_FREIGEGEBEN = 'Nicht gestartet: Das Modul wurde geändert und muss erst von einem Admin freigegeben werden.';

// Kennt alle Module, liest neue/geänderte Module ohne Neustart ein, übernimmt die status.json
// eigenständiger Module in den Verlauf und verwaltet Einstellungen und „aktiv“ (Pause).
// Ein fehlerhaftes Modul betrifft immer nur sich selbst.
// Mit freigaben (siehe freigabe.js) laufen ausführbare Module nur in dem Stand, den ein Admin freigegeben hat.
export class Modulverwaltung {
  constructor({ moduleOrdner, datenOrdner, speicher, planer, uebernehmen, nachTakt = null, dienste = new Dienststeuerung(), abbrechen = beendeLaufendeModule, geheimnisse = [], tresor = null, freigaben = null, log = () => {}, jetzt = () => Date.now(), intervallMs = 15_000 }) {
    Object.assign(this, { moduleOrdner, speicher, planer, uebernehmen, nachTakt, dienste, abbrechen, geheimnisse, tresor, freigaben, log, jetzt, intervallMs });
    this.verschluesselnAktiv = false; // erst nach erfolgreichem Start (siehe main.js, Umstellung)
    this.dienstZustand = new Map();
    this.zustandDatei = path.join(datenOrdner, 'modulzustand.json');
    this.module = [];
    this.signaturen = new Map();
    this.erkannt = new Map();
    this.statusMerker = new Map();
    this.zustand = {};
    this.pruefstand = new Map(); // id → aktueller Fingerabdruck { wert, angaben } oder { wert: null, fehler }
    this.hashCache = new Map();
    this.freigabeGemeldet = new Map(); // id → zuletzt gemeldeter Fingerabdruck (Meldung nur einmal je Stand)
    this.manuell = new Map(); // id → Zeit der letzten manuellen Prüfung
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
  // freigeben: { id, von, grund } – den neuen Stand dieses Moduls gleich freigeben (Modul-Update durch einen Admin).
  async einlesen({ freigeben = null } = {}) {
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
        // Neues oder aktualisiertes Modul mit „geheimnisse“: „dpapi“: Klartext-Passwörter sofort verschlüsseln.
        if (this.verschluesselnAktiv && m.geheimnisse) await this.modulVerschluesseln(m);
        for (const p of await passwoerter(m, this.tresor)) if (!this.geheimnisse.includes(p)) this.geheimnisse.push(p);
      }
    }
    for (const id of [...this.signaturen.keys()]) if (!ids.has(id)) { this.signaturen.delete(id); this.statusMerker.delete(id); this.dienstZustand.delete(id); this.manuell.delete(id); }
    if (this.freigaben) await this.freigabenPruefen(neu, freigeben);
    this.module = neu;
    this.planer?.setzeModule(this.planbar());
  }

  // Berechnet die Fingerabdrücke aller ausführbaren Module und vergleicht sie mit den Freigaben.
  async freigabenPruefen(neu, freigeben) {
    const stand = new Map();
    const cache = { alt: this.hashCache, neu: new Map() };
    for (const m of neu) {
      if (!braucht(m)) continue;
      // Für eine Freigabe immer frisch berechnen, nie aus dem Cache.
      stand.set(m.id, await fingerabdruck(m, { cache: freigeben?.id === m.id ? null : cache }));
    }
    this.hashCache = cache.neu;
    if (this.freigaben.ersterStart) {
      // Erster Start mit Freigaben: Was bisher lief, wird einmalig übernommen.
      const liste = [...stand].filter(([, fa]) => fa.wert).map(([id, fa]) => ({ id, ...fa }));
      await this.freigaben.setzen(liste, 'Basis', 'Übernahme beim ersten Start mit Modul-Freigaben');
      if (liste.length) this.log(`Modul-Freigaben eingeführt: bestehende Module übernommen (${liste.map((f) => f.id).join(', ')}). Jede weitere Änderung an ausführbaren Modulen muss ein Admin freigeben.`);
    }
    const fa = freigeben && stand.get(freigeben.id);
    if (fa?.wert && fa.wert !== this.freigaben.wert(freigeben.id)) {
      await this.freigaben.setzen([{ id: freigeben.id, ...fa }], freigeben.von, freigeben.grund);
      this.log(`Modul ${freigeben.id} freigegeben durch ${freigeben.von} (${freigeben.grund}).`);
    }
    this.pruefstand = stand;
    for (const id of [...this.freigabeGemeldet.keys()]) if (!stand.has(id)) this.freigabeGemeldet.delete(id);
    for (const m of neu) if (stand.has(m.id)) this.freigabeMelden(m);
  }

  // Meldet einmal je Stand, dass ein Modul auf Freigabe wartet.
  freigabeMelden(m) {
    const fa = this.pruefstand.get(m.id);
    if (!this.freigabeNoetig(m)) { this.freigabeGemeldet.delete(m.id); return; }
    const kennung = fa?.wert ?? `fehler:${fa?.fehler}`;
    if (this.freigabeGemeldet.get(m.id) === kennung) return;
    this.freigabeGemeldet.set(m.id, kennung);
    const info = this.freigabeInfo(m);
    const was = info.fehler ? info.fehler : info.aenderungen.slice(0, 5).join('; ') + (info.aenderungen.length > 5 ? ` (und ${info.aenderungen.length - 5} weitere)` : '');
    melde(this.log, 'warnung', `Modul ${m.id}`, `${info.neu ? 'Neues Modul' : 'Modul geändert'} – wird erst nach Freigabe durch einen Admin ausgeführt: ${was}`);
  }

  // true, wenn das Modul ausführbar ist und sein aktueller Stand nicht freigegeben ist.
  freigabeNoetig(m) {
    if (!this.freigaben || !braucht(m)) return false;
    const fa = this.pruefstand.get(m.id);
    return !fa?.wert || fa.wert !== this.freigaben.wert(m.id);
  }

  // Für die Anzeige: { neu, wert, aenderungen, fehler } oder null (keine Freigabe nötig).
  freigabeInfo(m) {
    if (!this.freigabeNoetig(m)) return null;
    const fa = this.pruefstand.get(m.id) ?? { wert: null, fehler: 'Das Modul wurde noch nicht geprüft.' };
    const eintrag = this.freigaben.eintrag(m.id);
    const schluessel = `${fa.wert}|${eintrag?.wert}`;
    if (fa.aenderungenFuer !== schluessel) {
      fa.aenderungen = fa.wert ? unterschiede(eintrag?.angaben ?? null, fa.angaben) : [];
      fa.aenderungenFuer = schluessel;
    }
    return { neu: !eintrag, wert: fa.wert, aenderungen: fa.aenderungen, fehler: fa.fehler ?? null };
  }

  // Vor jedem Start durch den Planer: Fingerabdruck frisch berechnen. Weicht er von der Freigabe ab,
  // startet das Modul nicht (Ergebnis „fehler“ statt Lauf). Liefert null, wenn das Modul laufen darf.
  async vorStart(m) {
    if (!this.freigaben || !braucht(m)) return null;
    const fa = await fingerabdruck(m);
    if (fa.wert && fa.wert === this.freigaben.wert(m.id)) return null;
    const aktuell = this.finde(m.id);
    if (aktuell) {
      this.pruefstand.set(m.id, fa);
      this.freigabeMelden(aktuell);
    }
    this.planer?.setzeModule(this.planbar());
    return { status: 'fehler', zusammenfassung: NICHT_FREIGEGEBEN, details: fa.fehler ? [fa.fehler] : unterschiede(this.freigaben.eintrag(m.id)?.angaben ?? null, fa.angaben, 20), messwerte: {}, beginn: new Date(this.jetzt()).toISOString(), dauerMs: 0 };
  }

  // Gibt den aktuellen Stand eines Moduls frei. erwartet = Fingerabdruck, den der Admin gesehen hat; hat sich das
  // Modul seitdem geändert, wird nichts freigegeben. Liefert { ok, text } oder { fehler } bzw. null (unbekannt).
  async freigeben(id, benutzer, { erwartet, grund = 'Freigabe in der Oberfläche' } = {}) {
    if (!this.freigaben) return { fehler: 'Freigaben sind nicht eingerichtet.' };
    return this.gesperrt(async () => {
      const m = this.finde(id);
      if (!m) return null;
      if (m.fehler) return { fehler: 'Das Modul ist fehlerhaft konfiguriert.' };
      if (!braucht(m)) return { fehler: 'Dieses Modul braucht keine Freigabe.' };
      if (typeof erwartet !== 'string' || !/^[0-9a-f]{64}$/.test(erwartet)) return { fehler: 'Fingerabdruck fehlt.' };
      const fa = await fingerabdruck(m);
      if (!fa.wert) { this.pruefstand.set(id, fa); return { fehler: `Freigabe nicht möglich: ${fa.fehler}` }; }
      if (fa.wert !== erwartet) {
        this.pruefstand.set(id, fa);
        return { fehler: 'Das Modul hat sich inzwischen erneut geändert. Bitte die Änderungen noch einmal ansehen und dann freigeben.' };
      }
      if (fa.wert === this.freigaben.wert(id)) { this.pruefstand.set(id, fa); return { ok: true, text: `Modul ${id} ist bereits freigegeben.` }; }
      const vorher = this.freigabeInfo(m);
      await this.freigaben.setzen([{ id, ...fa }], benutzer, grund);
      this.pruefstand.set(id, fa);
      this.freigabeGemeldet.delete(id);
      const text = `Modul ${id} freigegeben durch ${benutzer} (${vorher?.neu ? 'neues Modul' : `${vorher?.aenderungen?.length ?? 0} Änderung${vorher?.aenderungen?.length === 1 ? '' : 'en'}`}, Fingerabdruck ${fa.wert.slice(0, 12)}).`;
      this.log(text);
      this.planer?.setzeModule(this.planbar());
      return { ok: true, text };
    });
  }

  planbar() {
    return this.module.filter((m) => !this.freigabeNoetig(m)).map((m) => ({ ...m, aktiv: this.aktiv(m), einstellungenLaden: () => wirksameWerte(m, this.tresor) }));
  }

  async modulVerschluesseln(m) {
    try {
      const anzahl = await einstellungenVerschluesseln(m, this.tresor);
      if (anzahl) this.log(`Modul ${m.id}: ${anzahl} Passwort${anzahl === 1 ? '' : 'e'} verschlüsselt gespeichert.`);
      return anzahl;
    } catch (fehler) {
      melde(this.log, 'warnung', `Modul ${m.name}`, `Passwörter konnten nicht verschlüsselt werden: ${fehler.message}`);
      return 0;
    }
  }

  // Umstellung nach dem Start: alle Module, die verschlüsselte Passwörter lesen können. Liefert { verschluesselt, klartext: [Namen] }.
  async geheimnisseVerschluesseln() {
    this.verschluesselnAktiv = Boolean(this.tresor?.verfuegbar);
    let verschluesselt = 0;
    const klartext = [];
    for (const m of this.module) {
      if (m.fehler) continue;
      if (m.geheimnisse && this.verschluesselnAktiv) verschluesselt += await this.modulVerschluesseln(m);
      else if ((await passwoerter(m)).length) klartext.push(m.name);
    }
    return { verschluesselt, klartext };
  }

  // Übernimmt neue Meldungen eigenständiger Module aus deren status.json.
  async statusLesen() {
    for (const m of this.module) {
      if (m.fehler || m.typ !== 'eigenstaendig') continue;
      const merker = this.statusMerker.get(m.id) ?? { fehlversuche: 0, fehler: null };
      this.statusMerker.set(m.id, merker);
      let gelesen;
      try { gelesen = leseStatus(await leseBegrenzt(path.join(m.ordner, STATUS_DATEI), STATUS_JSON_MAX)); }
      catch (f) {
        if (f.code === 'ZU_GROSS') gelesen = { fehler: `status.json ist zu groß (höchstens ${STATUS_JSON_MAX / 1024} KB)` };
        else if (f.code === 'KEINE_DATEI') gelesen = { fehler: 'status.json ist keine normale Datei (Verknüpfungen sind nicht erlaubt)' };
        else { merker.fehlversuche = 0; merker.fehler = null; continue; }
      }
      const { eintrag, fehler } = gelesen;
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
      const empfangen = this.jetzt();
      const letztes = this.speicher.letztes(m.id);
      // Dieselbe Meldung nur einmal übernehmen (Vergleich mit der Zeit, die das Modul gemeldet hat).
      if ((letztes?.gemeldet ?? letztes?.ende) === eintrag.ende) continue;
      // Ältere Meldung als die zuletzt übernommene: ignorieren. Ein (früher gespeicherter) Eintrag aus der
      // Zukunft zählt dabei nicht, sonst würde er alle weiteren Meldungen blockieren.
      const letzteZeit = letztes ? Date.parse(letztes.ende ?? letztes.beginn) : NaN;
      if (letzteZeit <= empfangen && letzteZeit > Date.parse(eintrag.ende)) continue;
      const { eintrag: neu, warnung } = zeitBegrenzen(eintrag, empfangen);
      if (warnung && !merker.zukunftGemeldet) melde(this.log, 'warnung', `Modul ${m.id}`, warnung);
      merker.zukunftGemeldet = Boolean(warnung);
      await this.uebernehmen(m.id, neu);
      // Ein beendetes Modul, das sich danach wieder meldet, läuft wieder.
      const beendet = this.zustand[m.id]?.beendet;
      if (beendet && Date.parse(neu.ende) > Date.parse(beendet.zeit)) {
        await this.zustandAendern(m.id, { beendet: null });
        this.log(`Modul ${m.id} meldet sich wieder und gilt nicht mehr als beendet.`);
      }
    }
  }

  // Fragt den Zustand der Windows-Dienste ab, die Module in module.json angeben.
  async dienstePruefen() {
    // Nicht freigegebene Module: Dienstname könnte geändert sein – nicht abfragen.
    const mitDienst = this.module.filter((m) => !m.fehler && m.dienst && !this.freigabeNoetig(m));
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
      freigabe: m.fehler ? null : this.freigabeInfo(m),
      jetzt: this.jetzt(),
    });
  }

  ansichten() {
    return this.module.map((m) => this.ansicht(m)).sort((a, b) => a.schwere - b.schwere || a.name.localeCompare(b.name, 'de'));
  }

  verlauf(id, anzahl) { return this.speicher.verlauf(id, anzahl); }

  // Manuelle Prüfung. Liefert { code } mit code 'gestartet' | 'unbekannt' | 'fehlerhaft' | 'eigenstaendig' | 'pausiert' |
  // 'beendet' | 'freigabe' | 'laeuft' oder { code: 'warten', sekunden } (höchstens einmal pro Minute und Modul).
  jetztPruefen(id) {
    const m = this.finde(id);
    if (!m) return { code: 'unbekannt' };
    if (m.fehler) return { code: 'fehlerhaft' };
    if (m.typ === 'eigenstaendig') return { code: 'eigenstaendig' };
    if (!this.aktiv(m)) return { code: 'pausiert' };
    if (this.zustand[m.id]?.beendet) return { code: 'beendet' };
    if (this.freigabeNoetig(m)) return { code: 'freigabe' };
    const zuletzt = this.manuell.get(id);
    const rest = zuletzt === undefined ? 0 : zuletzt + MANUELL_ABSTAND_MS - this.jetzt();
    if (rest > 0) return { code: 'warten', sekunden: Math.ceil(rest / 1000) };
    if (!this.planer.jetztPruefen(id)) return { code: 'laeuft' };
    this.manuell.set(id, this.jetzt());
    return { code: 'gestartet' };
  }

  async einstellungen(id) {
    const m = this.finde(id);
    return m && !m.fehler ? einstellungsAnsicht(m) : null;
  }

  async einstellungenAendern(id, eingabe, benutzer) {
    const m = this.finde(id);
    if (!m || m.fehler) return null;
    const ergebnis = await einstellungenSpeichern(m, eingabe, this.verschluesselnAktiv ? this.tresor : null);
    if (ergebnis.geaendert?.length) {
      const namen = ergebnis.geaendert.map((k) => m.felder.find((f) => f.schluessel === k)?.bezeichnung ?? k);
      this.log(`Einstellungen von Modul ${id} geändert durch ${benutzer}: ${namen.join(', ')}.`);
      for (const p of await passwoerter(m, this.tresor)) if (!this.geheimnisse.includes(p)) this.geheimnisse.push(p);
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
    if (this.freigabeNoetig(m)) return { fehler: 'Das Modul wartet auf Freigabe durch einen Admin.' };
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
    if (this.freigabeNoetig(m)) return { fehler: 'Das Modul wartet auf Freigabe durch einen Admin.' };
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
      if (this.freigabeNoetig(m)) { fehler.push(`${m.name}: wartet auf Freigabe durch einen Admin, nicht beendet`); continue; }
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
