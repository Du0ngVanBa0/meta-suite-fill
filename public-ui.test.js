const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

test('chọn một video theo hàng và xóa lượt điền sau xác nhận', async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const page = await browser.newPage();
    const picks = [];
    const started = [];
    page.on('dialog', dialog => dialog.accept());
    await page.route('http://localhost.test/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/api/')) {
        const input = JSON.parse(route.request().postData() || '{}');
        let result;
        if (url.pathname === '/api/presets') result = { presets: {}, settings: {} };
        else if (url.pathname === '/api/read') result = { rows: [
          { row: 3, title: 'Ba', description: 'Mô tả ba' },
          { row: 4, title: 'Bốn', description: 'Mô tả bốn' }
        ] };
        else if (url.pathname === '/api/pick') {
          picks.push(input);
          result = { files: [picks.length === 1 ? 'C:\\videos\\three.mp4' : 'C:\\videos\\four.mp4'] };
        } else if (url.pathname === '/api/preset') result = { preset: { pattern: input.pattern, timeZone: '', startDate: input.startDate } };
        else if (url.pathname === '/api/start') {
          started.push(input.rows.map(row => ({ row: row.row, mode: row.mode, date: row.date, time: row.time })));
          result = { job: { id: 'test-job', stage: 'ready', rows: input.rows, current: 0, message: 'Sẵn sàng' } };
        } else if (url.pathname === '/api/job') result = { job: { stage: 'ready', rows: [{ row: 3 }], current: 0, message: 'Sẵn sàng' } };
        else if (url.pathname === '/api/clear') result = { job: { stage: 'cleared', rows: [], message: 'Đã xóa' } };
        else throw new Error(`Unexpected API ${url.pathname}`);
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) });
      }
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const contentType = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
      return route.fulfill({ contentType, body: fs.readFileSync(path.join(__dirname, 'public', file)) });
    });
    await page.goto('http://localhost.test/');
    await page.getByRole('button', { name: 'Đọc hàng' }).click();
    await page.getByRole('button', { name: 'Chọn video cho hàng 3' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.video-cell select')[0]?.value.endsWith('three.mp4'));
    assert.equal(await page.locator('#rows tr').nth(0).locator('.video-cell select').inputValue(), 'C:\\videos\\three.mp4');
    assert.equal(await page.locator('#rows tr').nth(1).locator('.video-cell select').inputValue(), '');
    await page.getByRole('combobox', { name: 'Cách đăng hàng 3' }).selectOption('now');
    await page.evaluate(() => {
      state.rows[0].date = '';
      state.rows[0].time = '';
      drawRows();
      state.tab = { id: 'tab', assetId: '12345', ready: true };
      updateStart();
    });
    assert.equal(await page.locator('#rows tr').nth(0).locator('input[type=date]').isDisabled(), true);
    assert.equal(await page.locator('#start').isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Đưa video hàng 3 vào Meta' }).isEnabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Đưa video hàng 4 vào Meta' }).isDisabled(), true);
    await page.getByRole('button', { name: 'Đưa video hàng 3 vào Meta' }).click();
    await page.getByText('Sẵn sàng', { exact: true }).waitFor();
    assert.deepEqual(started, [[{ row: 3, mode: 'now', date: '', time: '' }]]);
    await page.getByRole('button', { name: 'Xóa video lượt này trên Meta' }).click({ timeout: 3000 });
    await page.getByText('Đã xóa', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => state.jobId), null);
    await page.getByRole('button', { name: 'Chọn video cho hàng 4' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.video-cell select')[1]?.value.endsWith('four.mp4'));
    assert.equal(await page.locator('#rows tr').nth(0).locator('.video-cell select').inputValue(), 'C:\\videos\\three.mp4');
    assert.equal(await page.locator('#rows tr').nth(1).locator('.video-cell select').inputValue(), 'C:\\videos\\four.mp4');
    assert.deepEqual(picks, [{ single: true }, { single: true }]);
  } finally { await browser.close(); }
});
