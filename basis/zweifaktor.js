import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import qrcode from 'qrcode-generator';

// Zwei-Faktor-Anmeldung mit Einmalcodes aus einer Authenticator-App (TOTP nach RFC 6238:
// HMAC-SHA1, 30 Sekunden, 6 Ziffern) – funktioniert mit Microsoft/Google Authenticator, 1Password usw.
// Dazu Wiederherstellungscodes für den Fall, dass das Handy fehlt (gespeichert nur als SHA-256).

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const SCHRITT_MS = 30_000;

export function base32(puffer) {
  let bits = 0, wert = 0, text = '';
  for (const byte of puffer) {
    wert = (wert << 8) | byte;
    bits += 8;
    while (bits >= 5) { text += ALPHABET[(wert >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) text += ALPHABET[(wert << (5 - bits)) & 31];
  return text;
}

export function base32Lesen(text) {
  const sauber = String(text).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, wert = 0;
  const bytes = [];
  for (const z of sauber) {
    const i = ALPHABET.indexOf(z);
    if (i < 0) throw new Error('Ungültiges Base32.');
    wert = (wert << 5) | i;
    bits += 5;
    if (bits >= 8) { bytes.push((wert >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(bytes);
}

export const neuesGeheimnis = () => base32(randomBytes(20));

// Einmalcode für einen Zeitschritt (zaehler = Millisekunden / 30 000).
export function totp(geheimnis, zaehler, stellen = 6) {
  const nachricht = Buffer.alloc(8);
  nachricht.writeBigUInt64BE(BigInt(zaehler));
  const hmac = createHmac('sha1', Buffer.isBuffer(geheimnis) ? geheimnis : base32Lesen(geheimnis)).update(nachricht).digest();
  const versatz = hmac[hmac.length - 1] & 15;
  const zahl = (hmac.readUInt32BE(versatz) & 0x7fffffff) % 10 ** stellen;
  return String(zahl).padStart(stellen, '0');
}

// Prüft einen Code (aktueller Zeitschritt ±1, also ±30 s Uhrabweichung). Ein schon benutzter oder älterer
// Zeitschritt zählt nicht (kein zweites Mal mit demselben Code). Liefert den Zeitschritt oder null.
export function codePruefen(geheimnis, code, jetztMs, letzterZaehler = -1) {
  const eingabe = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(eingabe)) return null;
  const jetzt = Math.floor(jetztMs / SCHRITT_MS);
  for (const z of [jetzt - 1, jetzt, jetzt + 1]) {
    if (z <= letzterZaehler) continue;
    if (timingSafeEqual(Buffer.from(totp(geheimnis, z)), Buffer.from(eingabe))) return z;
  }
  return null;
}

export function otpauthUri(name, geheimnis, aussteller = 'Monitoring') {
  const e = encodeURIComponent;
  return `otpauth://totp/${e(aussteller)}:${e(name)}?secret=${geheimnis}&issuer=${e(aussteller)}&algorithm=SHA1&digits=6&period=30`;
}

// QR-Code als Bild (data:-URL, von der Content-Security-Policy erlaubt).
export function qrBild(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createDataURL(5, 12);
}

// Wiederherstellungscodes: 10 Stück wie „k7m2-x9qp-4f“ (ohne verwechselbare Zeichen), gespeichert nur als Hash.
const CODE_ZEICHEN = 'abcdefghjkmnpqrstuvwxyz23456789';
export const codeHash = (code) => createHash('sha256').update(String(code).toLowerCase().replace(/[\s-]/g, '')).digest('hex');
export function wiederherstellungsCodes(anzahl = 10) {
  const codes = Array.from({ length: anzahl }, () => {
    const z = Array.from({ length: 10 }, () => CODE_ZEICHEN[randomInt(CODE_ZEICHEN.length)]).join('');
    return `${z.slice(0, 4)}-${z.slice(4, 8)}-${z.slice(8)}`;
  });
  return { codes, hashes: codes.map(codeHash) };
}
