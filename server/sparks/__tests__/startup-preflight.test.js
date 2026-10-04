import test from "node:test";
import assert from "node:assert/strict";
import { evaluateStartupPreflight } from "../../startupPreflight.js";

test("startup preflight permits loopback and fails closed on direct LAN binding", () => {
  const safe = evaluateStartupPreflight({
    bindHost: "127.0.0.1",
    configWritable: true,
    secretsKey: { present: true, source: "file" },
    sshIdentity: { configured: false },
    localCollectors: { available: true },
  });
  assert.equal(safe.fatal, false);
  assert.equal(safe.authMode, "loopback-only");

  const exposed = evaluateStartupPreflight({
    bindHost: "0.0.0.0",
    tokenConfigured: false,
    configWritable: true,
    secretsKey: { present: true, source: "file" },
    sshIdentity: { configured: false },
    localCollectors: { available: true },
  });
  assert.equal(exposed.fatal, true);
  assert.match(exposed.errors.join(" "), /SPARKDASH_TOKEN|loopback|reverse proxy|Tailscale/i);

  const authed = evaluateStartupPreflight({
    bindHost: "0.0.0.0",
    tokenConfigured: true,
    configWritable: true,
    secretsKey: { present: true, source: "file" },
    sshIdentity: { configured: false },
    localCollectors: { available: true },
  });
  assert.equal(authed.fatal, false);
  assert.equal(authed.authMode, "bearer");
});
