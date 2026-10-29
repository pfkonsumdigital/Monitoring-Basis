// Startet Module nach ihrem Intervall und auf Knopfdruck. Ein Modul läuft nie doppelt.
export class Planer {
  constructor({ module, ausfuehren, speichern, log = () => {}, jetzt = () => Date.now() }) {
    this.module = module.filter((m) => !m.fehler);
    this.ausfuehren = ausfuehren;
    this.speichern = speichern;
    this.log = log;
    this.jetzt = jetzt;
    this.laufend = new Set();
    this.timer = new Map();
    this.naechsterLauf = new Map();
    this.gestoppt = false;
  }

  start(versatzMs = 2000) {
    this.module.filter((m) => m.aktiv && m.intervallMinuten).forEach((modul, index) => this.planen(modul, versatzMs * index));
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

  // Liefert false, wenn das Modul unbekannt ist oder bereits läuft.
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
        this.log(`Modul ${id}: Ergebnis konnte nicht gespeichert werden (${fehler?.code || fehler?.message || fehler}).`);
      } finally {
        this.laufend.delete(id);
        // Nächster Lauf zählt ab Ende dieses Laufs, damit sich Läufe nie überschneiden.
        if (modul.aktiv && modul.intervallMinuten) this.planen(modul, modul.intervallMinuten * 60_000);
      }
    })();
    return true;
  }
}
