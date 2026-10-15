const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { parsePattern } = require('./public/schedule');

test('mẫu giờ dùng chung không bị Page cũ ghi đè và còn sau khi tải lại', async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const page = await browser.newPage();
    const saved = { settings: { sheetUrl: '', sheetTab: '', rowList: '', titleColumn: '', descriptionColumn: '',
      startDate: '', pattern: '20:00, 22:00 | 06:00' }, presets: {
      12345: { pattern: '19:00, 21:00 | 07:00', timeZone: 'Asia/Jakarta' },
      67890: { pattern: '19:00, 21:00 | 07:00', timeZone: 'Asia/Saigon' }
    } };
    await page.route('http://localhost.test/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/api/')) {
        const input = JSON.parse(route.request().postData() || '{}');
        let result;
        if (url.pathname === '/api/presets') result = saved;
        else if (url.pathname === '/api/config') {
          saved.settings = { ...input.settings, pattern: parsePattern(input.settings.pattern).pattern };
          result = { settings: saved.settings };
        } else if (url.pathname === '/api/preset') result = { preset: input };
        else throw new Error(`Unexpected API ${url.pathname}`);
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) });
      }
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      return route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html',
        body: fs.readFileSync(path.join(__dirname, 'public', file)) });
    });
    await page.goto('http://localhost.test/');
    await page.getByText('Cấu hình Sheets và lịch dùng gần nhất được tự lưu trên máy.').waitFor();
    await page.evaluate(() => {
      state.tabs = [{ id: 'a', assetId: '12345', ready: true }, { id: 'b', assetId: '67890', ready: true }];
      const tab = document.querySelector('#tab');
      tab.append(new Option('A', 'a'), new Option('B', 'b'));
      tab.value = 'a';
      chooseTab();
    });
    assert.equal(await page.locator('#slots').inputValue(), '20:00, 22:00 | 06:00');
    await page.locator('#slots').fill('18,20 | 6');
    await page.getByRole('button', { name: 'Lưu giờ cho tất cả Page' }).click();
    await page.getByText('Đã lưu mẫu giờ cho tất cả Page trên máy.').waitFor();
    assert.equal(saved.settings.pattern, '18:00, 20:00 | 06:00');
    await page.locator('#tab').selectOption('b');
    assert.equal(await page.locator('#slots').inputValue(), '18:00, 20:00 | 06:00');
    await page.reload();
    await page.getByText('Cấu hình Sheets và lịch dùng gần nhất được tự lưu trên máy.').waitFor();
    assert.equal(await page.locator('#slots').inputValue(), '18:00, 20:00 | 06:00');
  } finally { await browser.close(); }
});
