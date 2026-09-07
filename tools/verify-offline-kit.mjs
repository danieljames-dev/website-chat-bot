import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(process.argv[2] || '.');
const setupPath = resolve(root, 'standard-setup.html');
const widgetPath = resolve(root, 'chat-bot.js');
const supportPath = resolve(root, 'support.html');
const privacyPath = resolve(root, 'privacy.html');

const [support, privacy] = await Promise.all([
  readFile(supportPath, 'utf8'),
  readFile(privacyPath, 'utf8'),
]);
assert.match(support, /US\$19 one-time digital product/);
assert.match(support, /14-day functionality guarantee/);
assert.match(privacy, /Privacy/i);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ acceptDownloads: true });
const externalRequests = [];
page.on('request', (request) => {
  if (/^https?:/i.test(request.url())) externalRequests.push(request.url());
});

try {
  const response = await page.goto(pathToFileURL(setupPath).href, { waitUntil: 'load' });
  assert.equal(response, null, 'file:// navigation should not require a network response');

  await page.fill('#name', 'Offline Fixture Plumbing');
  await page.fill('#services', 'Emergency leak repair\nBoiler servicing');
  await page.fill('#hours', 'Mon-Fri 8am-6pm');
  await page.fill('#phone', '+1 555 0100');
  await page.fill('#email', 'hello@example.com');
  await page.fill('#website', 'https://example.com');
  await page.fill('#pricing', 'Call-outs start at $89.');
  await page.fill('#faqs', 'Do you do emergency call-outs? | Yes, during opening hours.');

  await page.click('#generate');
  const downloadPromise = page.waitForEvent('download');
  await page.click('#download-config');
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), 'website-chat-bot-config.js');
  const configPath = await download.path();
  assert.ok(configPath, 'generated config download must have a local path');
  const configText = await readFile(configPath, 'utf8');
  assert.match(configText, /Offline Fixture Plumbing/);

  const widgetText = await readFile(widgetPath, 'utf8');
  assert.ok(widgetText.length > 1000, 'widget must be present in the downloaded kit');

  const runtime = await browser.newPage();
  await runtime.setContent('<!doctype html><html><body></body></html>');
  await runtime.addScriptTag({ content: configText });
  await runtime.addScriptTag({ path: widgetPath });
  await runtime.waitForSelector('website-chat-bot');

  const ask = async (question) => runtime.evaluate((q) => {
    const rootNode = document.querySelector('website-chat-bot').shadowRoot;
    rootNode.querySelector('.launcher').click();
    const input = rootNode.querySelector('input[type="text"]');
    input.value = q;
    rootNode.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    const messages = [...rootNode.querySelectorAll('.msg.bot')];
    const last = messages[messages.length - 1];
    return { text: last?.textContent ?? '', source: last?.dataset.source ?? '' };
  }, question);

  const known = await ask('when are you open');
  assert.match(known.text, /Mon-Fri 8am-6pm/);
  assert.equal(known.source, 'field:hours');

  const unknown = await ask('do you finance yachts');
  assert.match(unknown.text, /rather not guess/i);
  assert.equal(unknown.source, 'locale:unknown');

  assert.deepEqual(externalRequests, [], `offline setup made network requests: ${JSON.stringify(externalRequests)}`);
  console.log(JSON.stringify({
    status: 'PASS',
    mode: 'offline-downloaded-kit',
    setup: 'standard-setup.html',
    generatedConfig: download.suggestedFilename(),
    known,
    unknown,
    externalRequestCount: externalRequests.length,
  }));
} finally {
  await browser.close();
}
