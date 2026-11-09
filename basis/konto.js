import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { open, unlink, writeFile } from 'node:fs/promises';
import { befehlAusfuehren, SID_ADMINISTRATOREN, SID_SYSTEM } from './geheimnis.js';
import { melde } from './protokoll.js';

// Konto, unter dem die Basis läuft. Empfohlen ist ein eigenes Dienstkonto ohne Admin-Rechte
// (README „Eigenes Dienstkonto“, werkzeuge\konto-einrichten.ps1).

export const EINRICHTEN = 'Auf dem Worker als Admin werkzeuge\\konto-einrichten.ps1 ausführen (README „Eigenes Dienstkonto“).';

// Gruppen mit Admin-Rechten: lokale Administratoren, Domänen-Admins (-512), Schema-Admins (-518), Organisations-Admins (-519).
const istAdminGruppe = (sid) => sid === SID_ADMINISTRATOREN || /^S-1-5-21-\d+-\d+-\d+-(512|518|519)$/.test(sid);

// Liefert { name, sid, system, admin } oder null, wenn sich das Konto nicht ermitteln lässt.
// Unter Windows aus „whoami“ (CSV); die Gruppen enthalten auch nur zum Verweigern genutzte (UAC) – auch das zählt als Admin.
export async function kontoErmitteln({ ausfuehren = befehlAusfuehren(), plattform = process.platform } = {}) {
  if (plattform !== 'win32') {
    return { name: os.userInfo().username, sid: null, system: false, admin: process.getuid?.() === 0 };
  }
  const benutzer = await ausfuehren('whoami', ['/user', '/fo', 'csv', '/nh']);
  const treffer = /^"([^"]*)","(S-1-[0-9-]+)"/m.exec(benutzer.ausgabe ?? '');
  if (benutzer.code !== 0 || !treffer) return null;
  const gruppen = await ausfuehren('whoami', ['/groups', '/fo', 'csv', '/nh']);
  if (gruppen.code !== 0) return null;
  const sids = [...(gruppen.ausgabe ?? '').matchAll(/"(S-1-[0-9-]+)"/g)].map((t) => t[1]);
  const system = treffer[2] === SID_SYSTEM;
  return { name: treffer[1], sid: treffer[2], system, admin: system || sids.some(istAdminGruppe) };
}

// Prüft, ob das Konto dort schreiben darf, wo die Basis schreiben muss. ordner: Liste von Ordnern
// (fehlende werden übersprungen), datei: config.json (wird nur zum Schreiben geöffnet, nicht verändert).
// Liefert die Liste der Stellen ohne Schreibrecht.
export async function schreibrechtePruefen({ ordner = [], datei = null }) {
  const fehlt = [];
  for (const o of ordner) {
    const probe = path.join(o, `.schreibtest-${randomUUID()}.tmp`);
    try {
      await writeFile(probe, '');
      await unlink(probe);
    } catch (fehler) {
      if (fehler.code === 'ENOENT') continue;
      fehlt.push(o);
    }
  }
  if (datei) {
    try { await (await open(datei, 'r+')).close(); }
    catch (fehler) { if (fehler.code !== 'ENOENT') fehlt.push(datei); }
  }
  return fehlt;
}

// Ermittelt Konto und Schreibrechte und meldet das Ergebnis. Liefert die Angaben für die Oberfläche (Admins):
// { name, system, admin, fehlt: [Pfade] } oder null.
export async function kontoPruefen({ ordner, datei, log, ermitteln = kontoErmitteln }) {
  let konto = null;
  try { konto = await ermitteln(); } catch { konto = null; }
  if (!konto) {
    melde(log, 'warnung', 'Basis', 'Das Konto, unter dem die Basis läuft, ließ sich nicht ermitteln.');
    return null;
  }
  if (konto.system) melde(log, 'warnung', 'Basis', `Die Basis läuft als SYSTEM. Empfohlen ist ein eigenes Dienstkonto ohne Admin-Rechte. ${EINRICHTEN}`);
  else if (konto.admin) melde(log, 'warnung', 'Basis', `Die Basis läuft unter dem Konto ${konto.name} mit Administratorrechten. Empfohlen ist ein Konto ohne Admin-Rechte. ${EINRICHTEN}`);
  else log(`Die Basis läuft unter dem Konto ${konto.name} (kein Admin).`);
  const fehlt = await schreibrechtePruefen({ ordner, datei });
  if (fehlt.length) melde(log, 'fehler', 'Basis', `Das Konto ${konto.name} darf nicht schreiben in: ${fehlt.join(', ')}. ${EINRICHTEN}`);
  return { name: konto.name, system: konto.system, admin: konto.admin, fehlt };
}
