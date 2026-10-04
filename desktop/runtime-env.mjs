import fs from 'node:fs';
import path from 'node:path';

const DATA_FILES = {
  SPARKS_JSON_PATH: 'sparks.json',
  SETTINGS_JSON_PATH: 'settings.json',
  SPARKS_SECRETS_PATH: 'sparks-secrets.json',
  SECRETS_KEY_PATH: '.unused-plaintext-key',
  GPU_MEMORY_JSON_PATH: 'gpu-memory.json',
  LLM_DAILY_JSON_PATH: 'llm-daily.json',
  LLM_TOKEN_JSON_PATH: 'llm-token-totals.json',
  FLEET_ENERGY_JSON_PATH: 'fleet-energy.json',
  BENCH_HISTORY_PATH: 'bench-history.json',
  BENCH_ACTIVE_PATH: 'bench-active.json',
  PREFILL_BENCH_HISTORY_PATH: 'prefill-bench-history.json',
  PREFILL_BENCH_ACTIVE_PATH: 'prefill-bench-active.json',
  SHOWCASE_HISTORY_PATH: 'showcase-history.json',
};

/** Construct the entire worker environment; inherited backend overrides are unsafe. */
export function backendEnvironment({ dataDir, token, secretsKey, askpassPath, inherited = process.env }) {
  if (!path.isAbsolute(dataDir)) throw new Error('Desktop data directory must be absolute');
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Desktop session token is required');
  if (secretsKey != null && !/^[a-f0-9]{64}$/.test(secretsKey)) throw new Error('Invalid Keychain-protected secrets key');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const env = {};
  for (const key of ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'SSH_AUTH_SOCK', 'LANG']) {
    if (inherited[key]) env[key] = inherited[key];
  }
  Object.assign(env, {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    NODE_ENV: 'production',
    SPARKDASH_DESKTOP: '1',
    SPARKDASH_ALLOW_OPEN_REMOTE: '0',
    BIND_HOST: '127.0.0.1',
    PORT: '0',
    SPARKDASH_TOKEN: token,
    SSH_CONTROL_PERSIST_SECONDS: '15',
  });
  if (secretsKey) env.SPARKDASH_SECRETS_KEY = secretsKey;
  for (const [key, filename] of Object.entries(DATA_FILES)) env[key] = path.join(dataDir, filename);
  if (askpassPath) env.SPARKDASH_ASKPASS_PATH = askpassPath;
  return env;
}
