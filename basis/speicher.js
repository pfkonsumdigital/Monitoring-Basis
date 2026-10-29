import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

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
    for (const id of ids) {
      try {
        const liste = JSON.parse(await readFile(this.datei(id), 'utf8'));
        this.verlaeufe.set(id, Array.isArray(liste) ? liste.slice(0, this.maxAnzahl) : []);
      } catch {
        this.verlaeufe.set(id, []);
      }
    }
  }

  datei(id) { return path.join(this.ordner, `${id}.json`); }

  letztes(id) { return this.verlaeufe.get(id)?.[0] ?? null; }

  verlauf(id, anzahl = this.maxAnzahl) { return (this.verlaeufe.get(id) ?? []).slice(0, anzahl); }

  async hinzufuegen(id, ergebnis) {
    const liste = [ergebnis, ...(this.verlaeufe.get(id) ?? [])].slice(0, this.maxAnzahl);
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
