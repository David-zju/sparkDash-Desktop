import fs from 'node:fs';
import path from 'node:path';

const validKey = (key) => typeof key === 'string' && key.length <= 160 &&
  (key.startsWith('sparkdash.') || key.startsWith('sparkdash:') || key.startsWith('sparkdash-')) && !/token|secret|password/i.test(key);

export function createPreferences(dataDir) {
  const filename = path.join(dataDir, 'preferences.json');
  let values = {};
  if (fs.existsSync(filename)) {
    const saved = JSON.parse(fs.readFileSync(filename, 'utf8'));
    for (const [key, value] of Object.entries(saved)) {
      if (validKey(key) && typeof value === 'string' && value.length < 16384) values[key] = value;
    }
  }
  return {
    snapshot: () => ({ ...values }),
    set(key, value) {
      if (!validKey(key) || typeof value !== 'string' || value.length >= 16384) throw new Error('Invalid preference');
      const next = { ...values, [key]: value };
      if (Object.keys(next).length > 512) throw new Error('Too many preferences');
      fs.writeFileSync(`${filename}.tmp`, JSON.stringify(next), { mode: 0o600 });
      fs.renameSync(`${filename}.tmp`, filename);
      values = next;
    },
  };
}
