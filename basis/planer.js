import { melde } from './protokoll.js';

// Startet Module, die von der Basis ausgeführt werden („programm“, „plugin“), nach ihrem Intervall
// und auf Knopfdruck. Ein Modul läuft nie doppelt. Eigenständige Module plant die Basis nicht.
export class Planer {
  constructor({ module = [], ausfuehren, speichern, log = () => {}, jetzt = () => Date.now() }) {
    this.ausfuehren = ausfuehren;
    this.speichern = speichern;
    this.log = log;
    this.jetzt = jetzt;
    this.laufend = new Set();
    this.timer = new Map();
    this.naechsterLauf = new Map();
    this.signaturen = new Map();
    this.gestoppt = false;
    this.gestartet = false;
    this.module = [];
    this.setzeModule(module);
  }

  static geplant(m) { return !m.fehler && m.typ !== 'eigenstaendig'; }

  start(versatzMs = 2000) {
    this.gestartet = true;
    this.versatzMs = versatzMs;
    this.module.filter((m) => m.aktiv && m.intervallMinuten).forEach((modul, index) => this.planen(modul, versatzMs * index));
  }

  // Übernimmt eine neue Modulliste: neue oder geänderte Module werden (neu) geplant, entfernte abgemeldet.
  setzeModule(alle) {
    const neu = alle.filter(Planer.geplant);
    const ids = new Set(neu.map((m) => m.id));
    for (const id of [...this.signaturen.keys()]) {
      if (ids.has(id)) continue;
      clearTimeout(this.timer.get(id));
      this.timer.delete(id);
      this.naechsterLauf.delete(id);
      this.signaturen.delete(id);
    }
    let index = 0;
    for (const m of neu) {
      const signatur = JSON.stringify([m.aktiv, m.intervallMinuten]);
      const bekannt = this.signaturen.get(m.id);
      this.signaturen.set(m.id, signatur);
      if (!this.gestartet || bekannt === signatur || this.laufend.has(m.id)) continue;
      clearTimeout(this.timer.get(m.id));
      this.timer.delete(m.id);
      this.naechsterLauf.delete(m.id);
      if (m.aktiv && m.intervallMinuten) this.planen(m, (this.versatzMs ?? 2000) * index++);
    }
    this.module = neu;
  }

  stop() {
    this.gestoppt = true;
    for (const timer of this.timer.values()) clearTimeout(timer);
    this.timer.clear();
  }

  planen(modul, verzoegerungMs) {
    if (this.gestoppt) return;
    clearTimeout(this.timer.get(modul.id));
    this.naechsterLauf.set(modul.id, this.jetzt() + verzoegerungMs);
    const timer = setTimeout(() => this.jetztPruefen(modul.id), verzoegerungMs);
    timer.unref?.();
    this.timer.set(modul.id, timer);
  }

  laeuft(id) { return this.laufend.has(id); }

  naechster(id) { const zeit = this.naechsterLauf.get(id); return zeit ? new Date(zeit).toISOString() : null; }

  // Liefert false, wenn das Modul unbekannt ist, nicht von der Basis gestartet wird oder bereits läuft.
  jetztPruefen(id) {
    const modul = this.module.find((m) => m.id === id);
    if (!modul || this.laufend.has(id)) return false;
    this.laufend.add(id);
    this.naechsterLauf.delete(id);
    (async () => {
      try {
        const ergebnis = await this.ausfuehren(modul);
        await this.speichern(id, ergebnis);
        this.log(`Modul ${id}: ${ergebnis.status} – ${ergebnis.zusammenfassung}`);
      } catch (fehler) {
        melde(this.log, 'fehler', `Modul ${id}`, `Ergebnis konnte nicht gespeichert werden (${fehler?.code || fehler?.message || fehler}).`, fehler);
      } finally {
        this.laufend.delete(id);
        // Nächster Lauf zählt ab Ende dieses Laufs, damit sich Läufe nie überschneiden.
        // Maßgeblich ist der aktuelle Stand des Moduls (es kann sich inzwischen geändert haben).
        const aktuell = this.module.find((m) => m.id === id);
        if (aktuell?.aktiv && aktuell.intervallMinuten) this.planen(aktuell, aktuell.intervallMinuten * 60_000);
      }
    })();
    return true;
  }
}
