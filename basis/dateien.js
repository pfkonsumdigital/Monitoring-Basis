import { lstat, open } from 'node:fs/promises';

// Größenbegrenzungen für Dateien, die Module schreiben bzw. mitbringen und die die Basis liest.
export const MODUL_JSON_MAX = 256 * 1024;
export const STATUS_JSON_MAX = 1024 * 1024;
export const EINSTELLUNGEN_MAX = 1024 * 1024;

// Liest eine Datei mit Größenbegrenzung. Verknüpfungen und alles außer normalen Dateien werden abgelehnt.
// Fehlercodes: ENOENT (fehlt), KEINE_DATEI, ZU_GROSS.
export async function leseBegrenzt(datei, max) {
  const info = await lstat(datei);
  if (!info.isFile()) throw Object.assign(new Error('keine normale Datei'), { code: 'KEINE_DATEI' });
  if (info.size > max) throw Object.assign(new Error('zu groß'), { code: 'ZU_GROSS' });
  const handle = await open(datei, 'r');
  try {
    const puffer = Buffer.alloc(max + 1);
    let gelesen = 0;
    while (gelesen <= max) {
      const { bytesRead } = await handle.read(puffer, gelesen, max + 1 - gelesen, gelesen);
      if (!bytesRead) break;
      gelesen += bytesRead;
    }
    // Die Datei kann zwischen Prüfung und Lesen gewachsen sein.
    if (gelesen > max) throw Object.assign(new Error('zu groß'), { code: 'ZU_GROSS' });
    return puffer.subarray(0, gelesen).toString('utf8');
  } finally {
    await handle.close();
  }
}
