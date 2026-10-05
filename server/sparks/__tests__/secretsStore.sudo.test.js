/**
 * A damaged sudo entry must not take SSH passwords or LLM API keys with it:
 * outside the desktop app a failed load returns empty maps, and the next save
 * would then erase every credential from disk.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-secrets-sudo-"));
process.env.SPARKS_SECRETS_PATH = path.join(TMPDIR, "sparks-secrets.json");
process.env.SECRETS_KEY_PATH = path.join(TMPDIR, ".secrets-key");
delete process.env.SPARKDASH_DESKTOP;

const { loadSecrets, saveSecrets } = await import("../../secretsStore.js");
test.after(() => fs.rmSync(TMPDIR, { recursive: true, force: true }));

test("an undecryptable sudo entry keeps SSH passwords and API keys", () => {
  saveSecrets(new Map([["a", "ssh-secret"]]), new Map([["a", { 8000: "sk-key" }]]), new Map([["a", "sudo-a"], ["b", "sudo-b"]]));
  const file = JSON.parse(fs.readFileSync(process.env.SPARKS_SECRETS_PATH, "utf8"));
  file.sudoPasswords.a = "corrupted";
  fs.writeFileSync(process.env.SPARKS_SECRETS_PATH, JSON.stringify(file));

  const loaded = loadSecrets();
  assert.equal(loaded.passwords.get("a"), "ssh-secret");
  assert.deepEqual(loaded.llmApiKeys.get("a"), { 8000: "sk-key" });
  assert.equal(loaded.sudoPasswords.has("a"), false);
  assert.equal(loaded.sudoPasswords.get("b"), "sudo-b");
});

test("a v2 file without sudoPasswords still loads", () => {
  saveSecrets(new Map([["a", "ssh-secret"]]));
  const file = JSON.parse(fs.readFileSync(process.env.SPARKS_SECRETS_PATH, "utf8"));
  delete file.sudoPasswords;
  file.version = 2;
  fs.writeFileSync(process.env.SPARKS_SECRETS_PATH, JSON.stringify(file));
  const loaded = loadSecrets();
  assert.equal(loaded.passwords.get("a"), "ssh-secret");
  assert.equal(loaded.sudoPasswords.size, 0);
});
