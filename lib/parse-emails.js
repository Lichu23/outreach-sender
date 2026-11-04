const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;
const MAX_INPUT = 100_000;
const MAX_EMAIL_LENGTH = 254;

/**
 * Turns one pasted block into a clean list. Accepts commas, semicolons, spaces,
 * new lines and table pipes, plus "Name <a@b.com>" and mailto: links.
 * Words without "@" or "." are treated as names and ignored; anything that
 * looks like an attempted address but isn't valid is reported as invalid.
 */
export function parseEmails(raw) {
  const valid = [];
  const invalid = [];
  const duplicates = [];
  const seen = new Set();

  const tokens = String(raw ?? '').slice(0, MAX_INPUT).split(/[\s,;|*\\]+/);
  for (const token of tokens) {
    const email = token
      .replace(/^mailto:/i, '')
      .replace(/^[<("'[]+/, '')
      .replace(/[>)"'\].:]+$/, '')
      .toLowerCase();
    if (!email) continue;

    if (!email.includes('@') && !email.includes('.')) continue;

    if (email.length > MAX_EMAIL_LENGTH || !EMAIL.test(email)) {
      if (!invalid.includes(email)) invalid.push(email);
    } else if (seen.has(email)) {
      if (!duplicates.includes(email)) duplicates.push(email);
    } else {
      seen.add(email);
      valid.push(email);
    }
  }
  return { valid, invalid, duplicates };
}
