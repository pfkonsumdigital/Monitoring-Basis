import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { schreibeAtomar } from './einstellungen.js';
import { melde } from './protokoll.js';

// Tickets der IT (seit 0.20.0): Übersicht, anlegen, bearbeiten, Verlauf und zugeordnete E-Mails.
// Daten in data/tickets.json. Jede Änderung zählt `stand` hoch; die Oberfläche fragt alle 10 Sekunden
// mit diesem Stand nach und lädt nur bei Änderungen neu (auch Änderungen aus anderen Sitzungen und neue Mails).
//
// Ticketnummer: IT-<Jahr>-<laufende Nummer, mindestens dreistellig>, wie bei der bisherigen Ticketübersicht der
// IT-Assistenz (z. B. IT-2026-055). E-Mails werden über diese Nummer im Betreff zugeordnet.

export const STATUS = ['Offen', 'In Bearbeitung', 'Erledigt'];
export const NUMMER = /^IT-\d{4}-\d{3,5}$/;
const NUMMER_IM_TEXT = /\bIT-(\d{4})-(\d{3,5})\b/i;
const MAX_BETREFF = 200;
const MAX_BESCHREIBUNG = 20_000;
const MAX_MAILTEXT = 4000;
const MAX_VERLAUF_TEXT = 4000;
const FELDNAMEN = { betreff: 'Betreff', beschreibung: 'Beschreibung', status: 'Status' };

export class TicketFehler extends Error {
  constructor(meldung, status = 400, extra = {}) { super(meldung); this.status = status; Object.assign(this, extra); }
}

// Nummer aus einem Mail-Betreff (oder null). „it-2026-55“ zählt nicht – die Nummer ist immer mindestens dreistellig.
export function nummerAusBetreff(betreff) {
  const t = NUMMER_IM_TEXT.exec(String(betreff ?? ''));
  return t ? `IT-${t[1]}-${t[2]}` : null;
}

const kuerzen = (text, max) => (text.length > max ? `${text.slice(0, max)} …` : text);
const iso = (ms) => new Date(ms).toISOString();

// Prüft Eingaben aus der Oberfläche. Liefert die bereinigten Werte oder wirft TicketFehler mit feldfehler.
function pruefeEingabe(e, { neu }) {
  const feldfehler = {};
  const werte = {};
  if (neu || e.betreff !== undefined) {
    const b = typeof e.betreff === 'string' ? e.betreff.replace(/\s+/g, ' ').trim() : '';
    if (!b) feldfehler.betreff = 'Pflichtfeld';
    else if (b.length > MAX_BETREFF) feldfehler.betreff = `höchstens ${MAX_BETREFF} Zeichen`;
    werte.betreff = b;
  }
  if (neu || e.beschreibung !== undefined) {
    const b = typeof e.beschreibung === 'string' ? e.beschreibung.replace(/\r\n?/g, '\n').trimEnd() : e.beschreibung == null ? '' : null;
    if (b === null) feldfehler.beschreibung = 'ungültig';
    else if (b.length > MAX_BESCHREIBUNG) feldfehler.beschreibung = `höchstens ${MAX_BESCHREIBUNG} Zeichen`;
    werte.beschreibung = b ?? '';
  }
  if (neu || e.status !== undefined) {
    const s = e.status === undefined && neu ? 'Offen' : e.status;
    if (!STATUS.includes(s)) feldfehler.status = `„${STATUS.join('“, „')}“`;
    werte.status = s;
  }
  if (Object.keys(feldfehler).length) throw new TicketFehler('Bitte die markierten Felder prüfen.', 400, { feldfehler });
  return werte;
}

export class Tickets {
  constructor({ datenOrdner, log = () => {}, jetzt = () => Date.now() }) {
    Object.assign(this, { log, jetzt });
    this.datei = path.join(datenOrdner, 'tickets.json');
    this.tickets = [];
    this.mailIds = new Set();
    // Zähler für die automatische Aktualisierung (nur im Speicher; ein Neustart lädt die Oberfläche ohnehin neu).
    this.stand = 1;
    // Schreibvorgänge nacheinander, damit sich gleichzeitige Änderungen nicht überschreiben.
    this.kette = Promise.resolve();
  }

  async laden() {
    let roh;
    try { roh = JSON.parse(await readFile(this.datei, 'utf8')); }
    catch (fehler) {
      if (fehler.code === 'ENOENT') return;
      // Nicht still mit einer leeren Liste weitermachen – sonst würde der nächste Speichervorgang alle Tickets löschen.
      throw new Error(`data/tickets.json ist nicht lesbar (${fehler.message}). Datei prüfen oder aus der Sicherung zurückholen.`);
    }
    this.tickets = Array.isArray(roh?.tickets) ? roh.tickets.filter((t) => t && NUMMER.test(t.nummer)) : [];
    this.mailIds = new Set(this.tickets.flatMap((t) => t.verlauf.filter((v) => v.art === 'mail').map((v) => v.mail.nachrichtId)));
  }

  // Nacheinander ausführen und danach speichern.
  aendernUndSpeichern(arbeit) {
    const lauf = this.kette.then(async () => {
      const ergebnis = await arbeit();
      if (ergebnis?.unveraendert) return ergebnis.wert;
      await schreibeAtomar(this.datei, { tickets: this.tickets });
      this.stand += 1;
      return ergebnis?.wert;
    });
    this.kette = lauf.catch(() => {});
    return lauf;
  }

  finden(nummer) {
    const t = this.tickets.find((x) => x.nummer === nummer);
    if (!t) throw new TicketFehler('Ticket nicht gefunden.', 404);
    return t;
  }

  // Zeile der Übersicht. Aktivität = jüngste Änderung am Ticket oder jüngste E-Mail.
  static zeile(t) {
    const mails = t.verlauf.filter((v) => v.art === 'mail');
    const letzteMail = mails.reduce((m, v) => (!m || v.zeit > m ? v.zeit : m), null);
    // nurDatum: übernommene Tickets, bei denen die bisherige Übersicht nur das Datum der letzten Änderung kannte.
    return { nummer: t.nummer, betreff: t.betreff, status: t.status, geaendert: t.geaendert, ...(t.nurDatum ? { nurDatum: true } : {}), version: t.version,
      mails: { anzahl: mails.length, letzte: letzteMail }, aktivitaet: letzteMail && letzteMail > t.geaendert ? letzteMail : t.geaendert };
  }

  liste() {
    return this.tickets.map(Tickets.zeile).sort((a, b) => (a.aktivitaet < b.aktivitaet ? 1 : a.aktivitaet > b.aktivitaet ? -1 : b.nummer.localeCompare(a.nummer)));
  }

  ansicht(nummer) {
    const t = this.finden(nummer);
    return { ...Tickets.zeile(t), beschreibung: t.beschreibung, erstellt: t.erstellt, verlauf: [...t.verlauf].sort((a, b) => (a.zeit < b.zeit ? -1 : a.zeit > b.zeit ? 1 : 0)) };
  }

  // Nächste freie Nummer im aktuellen Jahr (die bisherigen Nummern der IT-Assistenz laufen weiter).
  naechsteNummer() {
    const jahr = new Date(this.jetzt()).getFullYear();
    const hoechste = this.tickets.map((t) => /^IT-(\d{4})-(\d+)$/.exec(t.nummer)).filter((t) => t && Number(t[1]) === jahr).reduce((m, t) => Math.max(m, Number(t[2])), 0);
    return `IT-${jahr}-${String(hoechste + 1).padStart(3, '0')}`;
  }

  anlegen(eingabe, benutzer) {
    return this.aendernUndSpeichern(() => {
      const werte = pruefeEingabe(eingabe ?? {}, { neu: true });
      const zeit = iso(this.jetzt());
      const t = { nummer: this.naechsteNummer(), ...werte, erstellt: zeit, geaendert: zeit, version: 1,
        verlauf: [{ zeit, art: 'erstellt', von: benutzer, werte: { betreff: werte.betreff, status: werte.status } }] };
      this.tickets.push(t);
      this.log(`Ticket ${t.nummer} angelegt durch ${benutzer}.`);
      return { wert: this.ansicht(t.nummer) };
    });
  }

  // Ändert Betreff, Beschreibung und/oder Status. `version` muss zum gespeicherten Stand passen, sonst hat inzwischen
  // jemand anderes geändert (409) – die Oberfläche zeigt dann den neuen Stand, statt ihn zu überschreiben.
  aendern(nummer, eingabe, benutzer) {
    return this.aendernUndSpeichern(() => {
      const t = this.finden(nummer);
      const e = eingabe ?? {};
      if (e.version !== t.version) throw new TicketFehler('Das Ticket wurde inzwischen geändert. Der aktuelle Stand ist geladen – bitte die Änderung prüfen und erneut speichern.', 409, { ticket: this.ansicht(nummer) });
      const werte = pruefeEingabe(e, { neu: false });
      const aenderungen = Object.keys(FELDNAMEN).filter((k) => k in werte && werte[k] !== t[k])
        .map((k) => ({ feld: k, vorher: kuerzen(t[k], MAX_VERLAUF_TEXT), nachher: kuerzen(werte[k], MAX_VERLAUF_TEXT) }));
      if (!aenderungen.length) return { unveraendert: true, wert: this.ansicht(nummer) };
      const zeit = iso(this.jetzt());
      Object.assign(t, werte, { geaendert: zeit, version: t.version + 1 });
      delete t.nurDatum;
      t.verlauf.push({ zeit, art: 'geaendert', von: benutzer, aenderungen });
      this.log(`Ticket ${nummer} geändert durch ${benutzer}: ${aenderungen.map((a) => FELDNAMEN[a.feld]).join(', ')}.`);
      return { wert: this.ansicht(nummer) };
    });
  }

  // Ordnet eine eingegangene E-Mail über die Ticketnummer im Betreff zu. Jede Mail (Message-ID) nur einmal.
  // Liefert 'zugeordnet' | 'doppelt' | 'ohne-nummer' | 'unbekannt' (Nummer ohne Ticket).
  mailZuordnen({ nachrichtId, von, name = '', betreff = '', zeit, text = '' }) {
    return this.aendernUndSpeichern(() => {
      const id = String(nachrichtId ?? '').trim();
      if (!id) throw new TicketFehler('Mail ohne Message-ID.');
      if (this.mailIds.has(id)) return { unveraendert: true, wert: { ergebnis: 'doppelt' } };
      const nummer = nummerAusBetreff(betreff);
      if (!nummer) return { unveraendert: true, wert: { ergebnis: 'ohne-nummer' } };
      const t = this.tickets.find((x) => x.nummer === nummer);
      if (!t) return { unveraendert: true, wert: { ergebnis: 'unbekannt', nummer } };
      const eingang = Number.isFinite(Date.parse(zeit)) ? iso(Date.parse(zeit)) : iso(this.jetzt());
      t.verlauf.push({ zeit: eingang, art: 'mail', von: String(von ?? '').slice(0, 320),
        mail: { nachrichtId: id, name: String(name ?? '').slice(0, 200), betreff: kuerzen(String(betreff), 500), text: kuerzen(String(text ?? '').replace(/\r\n?/g, '\n').trim(), MAX_MAILTEXT) } });
      this.mailIds.add(id);
      this.log(`E-Mail von ${von} dem Ticket ${nummer} zugeordnet.`);
      return { wert: { ergebnis: 'zugeordnet', nummer } };
    });
  }

  // Übernahme vorhandener Tickets (z. B. aus der bisherigen Ticketübersicht) mit ihren Nummern.
  // Vorhandene Nummern bleiben unverändert. Liefert { neu, vorhanden, fehler: [] }.
  importieren(liste, quelle) {
    return this.aendernUndSpeichern(() => {
      const ergebnis = { neu: 0, vorhanden: 0, fehler: [] };
      const zeit = iso(this.jetzt());
      for (const [i, roh] of (Array.isArray(liste) ? liste : []).entries()) {
        const nummer = typeof roh?.nummer === 'string' ? roh.nummer.trim().toUpperCase() : '';
        if (!NUMMER.test(nummer)) { ergebnis.fehler.push(`Eintrag ${i + 1}: Nummer „${roh?.nummer ?? ''}“ ungültig`); continue; }
        if (this.tickets.some((t) => t.nummer === nummer)) { ergebnis.vorhanden += 1; continue; }
        let werte;
        try { werte = pruefeEingabe({ betreff: roh.betreff, beschreibung: roh.beschreibung ?? '', status: roh.status }, { neu: true }); }
        catch (fehler) { ergebnis.fehler.push(`${nummer}: ${Object.entries(fehler.feldfehler ?? {}).map(([k, v]) => `${FELDNAMEN[k]} ${v}`).join(', ')}`); continue; }
        // Nur ein Datum (JJJJ-MM-TT): Mitternacht Ortszeit, die Oberfläche zeigt dann nur das Datum.
        const nurDatum = typeof roh.geaendert === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(roh.geaendert);
        const geaendertMs = nurDatum ? Date.parse(`${roh.geaendert}T00:00:00`) : Date.parse(roh.geaendert);
        const geaendert = Number.isFinite(geaendertMs) ? iso(geaendertMs) : zeit;
        const erstellt = Number.isFinite(Date.parse(roh.erstellt)) ? iso(Date.parse(roh.erstellt)) : geaendert;
        this.tickets.push({ nummer, ...werte, erstellt, geaendert, ...(nurDatum && Number.isFinite(geaendertMs) ? { nurDatum: true } : {}), version: 1,
          verlauf: [{ zeit, art: 'import', von: String(quelle ?? 'Import').slice(0, 200), werte: { betreff: werte.betreff, status: werte.status },
            ...(roh.hinweis ? { hinweis: kuerzen(String(roh.hinweis), 1000) } : {}) }] });
        ergebnis.neu += 1;
      }
      if (!ergebnis.neu) return { unveraendert: true, wert: ergebnis };
      return { wert: ergebnis };
    });
  }
}

// Liest eine Importdatei (data/tickets-import.json) beim Start einmalig ein und benennt sie danach um.
export async function importDateiUebernehmen(tickets, datenOrdner, log, umbenennen) {
  const datei = path.join(datenOrdner, 'tickets-import.json');
  let roh;
  try { roh = JSON.parse(await readFile(datei, 'utf8')); }
  catch (fehler) {
    if (fehler.code !== 'ENOENT') melde(log, 'fehler', 'Tickets', `tickets-import.json ist nicht lesbar: ${fehler.message}`);
    return null;
  }
  const r = await tickets.importieren(roh?.tickets, roh?.quelle ?? 'Import');
  melde(log, r.fehler.length ? 'warnung' : 'info', 'Tickets', `Import aus tickets-import.json: ${r.neu} übernommen, ${r.vorhanden} schon vorhanden${r.fehler.length ? `, ${r.fehler.length} fehlerhaft (${r.fehler.slice(0, 5).join('; ')})` : ''}.`);
  await umbenennen(datei, `${datei}.uebernommen-${new Date().toISOString().slice(0, 10)}`);
  return r;
}
