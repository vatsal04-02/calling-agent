'use strict';
const fs = require('fs');
const path = require('path');
const fixture = require('../scripts/fixture-server');
const mocks = require('../scripts/mock-services');
const { loadSettings } = require('../scripts/local-pipeline');

const ROOT = path.join(__dirname, '..');
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

async function startServers() {
  const fx = fixture.createServer();
  const mk = mocks.createServer();
  const fxUrl = await listen(fx);
  const mkUrl = await listen(mk);
  return { fx, mk, fxUrl, mkUrl, close: () => { fx.close(); mk.close(); } };
}

// Settings for tests: synthetic domains allowed, fixture + mock endpoints, real-looking sender.
function testSettings(urls, overrides) {
  const { deepMerge } = require('../scripts/local-pipeline');
  const base = loadSettings({
    spreadsheet_id: 'TEST_SPREADSHEET',
    allow_synthetic_domains: true,
    fixture_base_url: urls ? urls.fxUrl : '',
    research: { request_interval_ms: 0 },
    llm: { endpoint: urls ? `${urls.mkUrl}/v1/messages` : '' },
    sender: { name: 'Alex Tester', email: 'sender@flowhq-test.example', postal_address: '1 Test Street, Testville', reply_to: '' },
    sending: { gmail_api_base: urls ? urls.mkUrl : 'http://127.0.0.1:1', send_interval_seconds: 0, send_jitter_seconds: 0 },
  });
  return deepMerge(base, overrides || {});
}

module.exports = { ROOT, readJson, startServers, testSettings };
