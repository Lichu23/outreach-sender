import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const EMPTY = () => ({ campaign: null, sends: [], history: [], suppressed: [], sendLog: [] });

/** Keeps state in one JSON file. Writes via a temp file so a crash can't leave it half-written. */
export function createStore(path) {
  let state = EMPTY();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    state = {
      campaign: parsed.campaign ?? null,
      sends: Array.isArray(parsed.sends) ? parsed.sends : [],
      history: Array.isArray(parsed.history) ? parsed.history : [],
      suppressed: Array.isArray(parsed.suppressed) ? parsed.suppressed : [],
      sendLog: Array.isArray(parsed.sendLog) ? parsed.sendLog : [],
    };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new Error(`Could not read ${path}. Fix or remove it, because it holds your sent history.`);
    }
  }

  return {
    state,
    save() {
      mkdirSync(dirname(path), { recursive: true });
      const temp = `${path}.tmp`;
      writeFileSync(temp, JSON.stringify(state, null, 2));
      renameSync(temp, path);
    },
  };
}
