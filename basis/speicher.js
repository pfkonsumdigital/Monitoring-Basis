import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

// Details nur bei den neuesten Einträgen behalten, damit lange Verläufe klein bleiben.
const DETAILS_BEHALTEN = 50;

// Hält je Modul den Verlauf (neueste zuerst) im Speicher und in data/ergebnisse/<id>.json.
export class Ergebnisspeicher {
  constructor(datenOrdner, maxAnzahl) {
    this.ordner = path.join(datenOrdner, 'ergebnisse');
    this.maxAnzahl = maxAnzahl;
    this.verlaeufe = new Map();
    this.schreiben = new Map();
  }

  async laden(ids) {
    await mkdir(this.ordner, { recursive: true });
    for (const id of ids) await this.sicherstellen(id);
  }

  // Lädt den Verlauf eines Moduls, falls noch nicht geschehen (auch für später hinzugekommene Module).
  async sicherstellen(id) {
    if (this.verlaeufe.has(id)) return;
    await mkdir(this.ordner, { recursive: true });
    let liste = [];
    try {
      const roh = JSON.parse(await readFile(this.datei(id), 'utf8'));
      if (Array.isArray(roh)) liste = roh.slice(0, this.maxAnzahl);
    } catch { /* noch kein Verlauf */ }
    if (!this.verlaeufe.has(id)) this.verlaeufe.set(id, liste);
  }

  datei(id) { return path.join(this.ordner, `${id}.json`); }

  letztes(id) { return this.verlaeufe.get(id)?.[0] ?? null; }

  verlauf(id, anzahl = this.maxAnzahl) { return (this.verlaeufe.get(id) ?? []).slice(0, anzahl); }

  async hinzufuegen(id, ergebnis) {
    const liste = [ergebnis, ...(this.verlaeufe.get(id) ?? [])].slice(0, this.maxAnzahl);
    const alt = liste[DETAILS_BEHALTEN];
    if (alt && (alt.details?.length || alt.fehlerausgabe)) {
      const { fehlerausgabe, ...rest } = alt;
      liste[DETAILS_BEHALTEN] = { ...rest, details: [] };
    }
    this.verlaeufe.set(id, liste);
    // Schreibvorgänge je Modul nacheinander, damit keine ältere Fassung eine neuere überschreibt.
    const vorher = this.schreiben.get(id) ?? Promise.resolve();
    const jetzt = vorher.then(() => this.atomarSchreiben(this.datei(id), liste));
    this.schreiben.set(id, jetzt.catch(() => {}));
    await jetzt;
  }

  async atomarSchreiben(datei, wert) {
    const temp = `${datei}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(wert), { mode: 0o600 });
      await rename(temp, datei);
    } finally {
      await unlink(temp).catch(() => {});
    }
  }
}
