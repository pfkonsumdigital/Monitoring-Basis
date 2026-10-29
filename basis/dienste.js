import { execFile } from 'node:child_process';

// Steuert die Windows-Dienste, die Module in module.json („dienst“) angeben, über sc.exe.
// Die Basis fasst nur diese Dienste an – nie andere.

export const DIENST_MUSTER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;

// Zahlencodes von sc.exe sind in allen Sprachen gleich (die Wörter dahinter auch).
const ZUSTAENDE = { 1: 'gestoppt', 2: 'startet', 3: 'stoppt', 4: 'laeuft', 5: 'startet', 6: 'stoppt', 7: 'pausiert' };

export function zustandLesen(ausgabe) {
  const treffer = /:\s*([1-7])\s+(STOPPED|START_PENDING|STOP_PENDING|RUNNING|CONTINUE_PENDING|PAUSE_PENDING|PAUSED)\b/.exec(String(ausgabe));
  return treffer ? ZUSTAENDE[treffer[1]] : 'unbekannt';
}

// Windows-Fehlercodes von sc.exe (Exitcode) in verständliche Sätze.
function fehlerText(code, name, ausgabe) {
  return {
    5: `Keine Berechtigung für den Dienst „${name}“. Die Basis muss dafür als Autostart (Konto SYSTEM) oder als Administrator laufen.`,
    1060: `Der Dienst „${name}“ ist auf diesem Rechner nicht installiert.`,
    1056: `Der Dienst „${name}“ läuft bereits.`,
    1062: `Der Dienst „${name}“ läuft nicht.`,
    1058: `Der Dienst „${name}“ ist deaktiviert (Starttyp „Deaktiviert“).`,
    1053: `Der Dienst „${name}“ hat nicht rechtzeitig reagiert.`,
  }[code] ?? `sc.exe meldet Fehler ${code ?? 'unbekannt'} für den Dienst „${name}“${ausgabe ? `: ${String(ausgabe).trim().split(/\r?\n/).pop()}` : '.'}`;
}

export class DienstFehler extends Error {
  constructor(text, code = null) { super(text); this.code = code; }
}

export class Dienststeuerung {
  constructor({ execImpl = execFile, plattform = process.platform } = {}) {
    Object.assign(this, { execImpl, plattform });
  }

  verfuegbar() { return this.plattform === 'win32'; }

  sc(argumente) {
    return new Promise((resolve) => {
      this.execImpl('sc.exe', argumente, { windowsHide: true, timeout: 15_000 }, (fehler, stdout = '', stderr = '') => {
        resolve({ code: fehler ? (typeof fehler.code === 'number' ? fehler.code : null) : 0, ausgabe: `${stdout}${stderr}`, startFehler: fehler && typeof fehler.code !== 'number' ? fehler : null });
      });
    });
  }

  async ausfuehren(befehl, name) {
    if (!DIENST_MUSTER.test(name ?? '')) throw new DienstFehler('Ungültiger Dienstname.');
    if (!this.verfuegbar()) throw new DienstFehler('Windows-Dienste gibt es nur unter Windows.');
    const r = await this.sc([befehl, name]);
    if (r.startFehler) throw new DienstFehler(`sc.exe konnte nicht ausgeführt werden (${r.startFehler.code ?? r.startFehler.message}).`);
    if (r.code !== 0) throw new DienstFehler(fehlerText(r.code, name, r.ausgabe), r.code);
    return r.ausgabe;
  }

  // Liefert { zustand: laeuft|gestoppt|startet|stoppt|pausiert|unbekannt|fehlt|nicht-verfuegbar, fehler? }
  async zustand(name) {
    if (!this.verfuegbar()) return { zustand: 'nicht-verfuegbar' };
    try { return { zustand: zustandLesen(await this.ausfuehren('query', name)) }; }
    catch (fehler) { return { zustand: fehler.code === 1060 ? 'fehlt' : 'unbekannt', fehler: fehler.message }; }
  }

  // Bereits gestoppt bzw. bereits laufend gilt als Erfolg.
  async beenden(name) {
    try { await this.ausfuehren('stop', name); } catch (fehler) { if (fehler.code !== 1062) throw fehler; }
  }

  async starten(name) {
    try { await this.ausfuehren('start', name); } catch (fehler) { if (fehler.code !== 1056) throw fehler; }
  }
}
