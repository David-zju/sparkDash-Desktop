// Environment is supplied by the main process before any backend imports.
import { createBackend } from '../server/index.js';

let pendingKey;
let keyReply;
let nextKeyRequest = 0;
function prepareCredentials() {
  if (process.env.SPARKDASH_SECRETS_KEY) return Promise.resolve();
  if (pendingKey) return pendingKey;
  pendingKey = new Promise((resolve, reject) => {
    const requestId = ++nextKeyRequest;
    const timer = setTimeout(() => { keyReply = null; reject(new Error('安全存储授权超时，请重试保存')); }, 120000);
    timer.unref();
    keyReply = (data) => {
      if (data.requestId !== requestId) return;
      clearTimeout(timer);
      keyReply = null;
      if (data.error) return reject(new Error(data.error));
      if (!/^[a-f0-9]{64}$/.test(data.key)) return reject(new Error('Invalid credential key response'));
      process.env.SPARKDASH_SECRETS_KEY = data.key;
      resolve();
    };
    process.parentPort.postMessage({ type: 'secrets-key-request', requestId });
  }).finally(() => { pendingKey = null; });
  return pendingKey;
}
const backend = createBackend({ prepareCredentials });
let stopping = false;
async function stop(reason) {
  if (stopping) return;
  stopping = true;
  try {
    const result = await backend.stop(reason);
    process.parentPort.postMessage({ type: 'stopped', persisted: result.persisted });
    process.exit(result.persisted ? 0 : 1);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
process.parentPort.on('message', ({ data }) => {
  if (data?.type === 'stop') void stop(data.reason || 'App stopped');
  if (data?.type === 'secrets-key-result') keyReply?.(data);
});
process.on('SIGTERM', () => void stop('App stopped'));
try {
  const { origin } = await backend.start();
  process.parentPort.postMessage({ type: 'ready', origin });
} catch (error) {
  process.parentPort.postMessage({ type: 'failed', message: error.message });
  process.exit(1);
}
