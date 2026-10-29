// Beispiel-Plugin: prüft den freien Speicherplatz eines Laufwerks.
import { statfs } from 'node:fs/promises';

export async function pruefen({ einstellungen }) {
  const { pfad, warnung_unter_prozent: warnung = 15, fehler_unter_prozent: fehler = 5 } = einstellungen;
  const info = await statfs(pfad);
  const gesamtGb = (info.blocks * info.bsize) / 1e9;
  const freiGb = (info.bavail * info.bsize) / 1e9;
  const freiProzent = (freiGb / gesamtGb) * 100;
  const status = freiProzent < fehler ? 'fehler' : freiProzent < warnung ? 'warnung' : 'ok';
  return {
    status,
    zusammenfassung: `${freiGb.toFixed(1)} GB frei (${freiProzent.toFixed(1)} %) auf ${pfad}`,
    messwerte: { frei_gb: Number(freiGb.toFixed(2)), frei_prozent: Number(freiProzent.toFixed(1)), gesamt_gb: Number(gesamtGb.toFixed(2)) },
  };
}
