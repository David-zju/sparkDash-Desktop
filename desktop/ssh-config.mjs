import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isAllowedTargetHost } from '../server/validate.js';

// Enumerate concrete destinations only. OpenSSH remains responsible for resolving
// Host/Match precedence, keys and ProxyJump when the user actually connects.
// In particular, do not use `ssh -G`: evaluating Match exec can run commands.
function words(value) {
  const result = [];
  let word = '', quote = '', escaped = false;
  for (const ch of value) {
    if (escaped) { word += ch; escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (quote) {
      if (ch === quote) quote = ''; else word += ch;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '#') break;
    else if (/\s/.test(ch)) { if (word) result.push(word); word = ''; }
    else word += ch;
  }
  if (word) result.push(word);
  return result;
}

export async function listSshAliases({ home = os.homedir(), systemConfig = '/etc/ssh/ssh_config', env = process.env } = {}) {
  const aliases = new Set();
  const visited = new Set();
  const warnings = new Set();
  let totalBytes = 0;
  async function read(filename, base, depth = 0) {
    if (depth > 16 || visited.size >= 128 || aliases.size >= 1024 || totalBytes >= 2_000_000) {
      warnings.add('SSH config import reached its size limit; some aliases may be missing.');
      return;
    }
    let content;
    try {
      const real = await fs.realpath(filename);
      if (visited.has(real)) return;
      visited.add(real);
      const info = await fs.stat(real);
      if (!info.isFile() || info.size > 256_000 || totalBytes + info.size > 2_000_000) {
        warnings.add('An oversized or non-file SSH config entry was skipped.');
        return;
      }
      content = await fs.readFile(real, 'utf8');
      totalBytes += Buffer.byteLength(content);
    } catch (error) {
      if (error.code !== 'ENOENT') warnings.add('Some SSH configuration files could not be read. Check their permissions.');
      return;
    }
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*(Host|Include)\s*(?:=\s*|\s+)(.*)$/i);
      if (!match) continue;
      const values = words(match[2]);
      if (match[1].toLowerCase() === 'host') {
        for (const alias of values) {
          if (aliases.size < 1024 && isAllowedTargetHost(alias)) aliases.add(alias);
        }
        continue;
      }
      for (let pattern of values) {
        pattern = pattern.replace(/\$\{([^}]+)\}/g, (_, name) => env[name] ?? '${' + name + '}');
        pattern = pattern.replace(/^~(?=\/|$)/, home).replace(/%d/g, home);
        if (pattern.startsWith('~') || /[%$]/.test(pattern)) {
          warnings.add('An Include path uses unsupported expansion; its aliases may need manual entry.');
          continue;
        }
        pattern = path.isAbsolute(pattern) ? pattern : path.join(base, pattern);
        try {
          // Glob expansion and file reads are local only; never read key contents.
          const matches = [];
          for await (const entry of fs.glob(pattern)) {
            matches.push(entry);
            if (matches.length >= 128) { warnings.add('An Include matched too many files; some aliases may be missing.'); break; }
          }
          for (const entry of matches.sort()) await read(entry, base, depth + 1);
        } catch {
          warnings.add('An SSH Include could not be read.');
        }
      }
    }
  }
  await read(path.join(home, '.ssh/config'), path.join(home, '.ssh'));
  if (systemConfig) await read(systemConfig, path.dirname(systemConfig));
  return { aliases: [...aliases].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), warnings: [...warnings] };
}
