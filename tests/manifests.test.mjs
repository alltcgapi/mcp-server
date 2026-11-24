// I manifest lanciano il pacchetto npm a una versione esatta: le directory
// rifiutano un npx senza pin. Un rilascio che alza package.json e dimentica un
// manifest pubblicherebbe un plugin che installa la versione vecchia, e
// nessuno se ne accorgerebbe.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { FOREIGN } from './helpers.mjs';

const read = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));

const pkg = read('package.json');
const pinned = `${pkg.name}@${pkg.version}`;

test('server.json: nome, versione e pacchetto coincidono con package.json', () => {
  const manifest = read('server.json');
  assert.equal(manifest.name, pkg.mcpName);
  assert.equal(manifest.version, pkg.version);
  const [npm] = manifest.packages;
  assert.equal(npm.identifier, pkg.name);
  assert.equal(npm.version, pkg.version);
  // Il registro MCP tronca oltre i 100 caratteri.
  assert.ok(manifest.description.length <= 100, manifest.description.length);
  assert.deepEqual(npm.environmentVariables.map((v) => v.name), ['ALLTCG_API_KEY', 'ALLTCG_BASE_URL']);
  assert.equal(manifest.remotes[0].url, 'https://mcp.alltcgapi.com/mcp');
});

test('il plugin Claude lancia la versione di package.json, con la chiave dal campo sensibile', () => {
  const manifest = read('.claude-plugin/plugin.json');
  assert.equal(manifest.version, pkg.version);
  const server = manifest.mcpServers.alltcgapi;
  assert.deepEqual(server.args, ['-y', pinned]);
  assert.equal(server.env.ALLTCG_API_KEY, '${user_config.api_key}');
  assert.equal(manifest.userConfig.api_key.sensitive, true);
});

test('mcp.json e il plugin Cursor: stessa versione, ogni variabile dichiarata', () => {
  const manifest = read('.cursor-plugin/plugin.json');
  assert.equal(manifest.version, pkg.version);
  const server = read('mcp.json').mcpServers.alltcgapi;
  assert.deepEqual(server.args, ['-y', pinned]);
  for (const value of Object.values(server.env)) {
    const name = /^\$\{(\w+)\}$/.exec(value)?.[1];
    assert.ok(name && manifest.variables.properties[name], `variabile non dichiarata: ${value}`);
  }
});

test('glama.json e context7.json sono JSON validi e senza chiavi di rivendicazione inventate', () => {
  assert.deepEqual(read('glama.json').maintainers, ['ggxforce']);
  const context7 = read('context7.json');
  assert.equal(context7.public_key, undefined);
  assert.ok(context7.rules.length > 0);
});

test('nessun file pubblicato nomina fonti interne o altri prodotti', () => {
  const sources = readdirSync(new URL('../src/', import.meta.url)).map((f) => `src/${f}`);
  const published = [
    'package.json', 'server.json', 'mcp.json', 'glama.json', 'context7.json', 'README.md', 'Dockerfile',
    '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', '.cursor-plugin/plugin.json',
    'skills/tcg-card-data/SKILL.md', ...sources,
  ];
  for (const path of published) {
    const text = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, FOREIGN, path);
  }
});
