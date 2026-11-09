// The robot check in front of account creation and login with a code: proof of work, solved in the browser.
// No third party, no cookies. The server (app/captcha.py) sends a challenge; we try numbers until
// SHA-256(salt + number) matches, then send the solution with POST /api/auth/otp/start.
import { api } from "./api";

type Challenge = { enabled: boolean; algorithm: string; challenge: string; salt: string; maxnumber: number; signature: string };

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Returns the solution to send as `captcha`, or null when the server has the check switched off. */
export async function solveCaptcha(): Promise<string | null> {
  const c = await api.get<Challenge>("/api/auth/captcha");
  if (!c.enabled) return null;
  if (!crypto?.subtle) throw new Error("Browseren kan ikke klare robottjekket. Brug en nyere browser.");
  const enc = new TextEncoder();
  for (let n = 0; n <= c.maxnumber; n++) {
    if (hex(await crypto.subtle.digest("SHA-256", enc.encode(c.salt + n))) === c.challenge) {
      const { algorithm, challenge, salt, signature } = c;
      return btoa(JSON.stringify({ algorithm, challenge, salt, signature, number: n }));
    }
  }
  throw new Error("Robottjekket kunne ikke løses. Prøv igen.");
}
