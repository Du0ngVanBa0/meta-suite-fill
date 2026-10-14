const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { chromium } = require('playwright-core');
const { shortTitle, caption } = require('./sheets');

const API_BASE = 'http://127.0.0.1:50325';
const connections = new Map();
const tabs = new Map();
const execFileAsync = promisify(execFile);
const DESCRIPTION = 'textarea[placeholder*="Describe"], [role="textbox"][contenteditable="true"]';

async function adsRequest(apiKey, endpoint) {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(10000)
  });
  const data = await response.json();
  if (!response.ok || data.code !== 0) {
    throw new Error(`AdsPower Local API: ${data.msg || response.status}. Bật Local API và nhập API key nếu được yêu cầu.`);
  }
  return data.data;
}

async function listProfiles(apiKey) {
  try {
    const data = await adsRequest(apiKey, '/api/v1/browser/local-active');
    return (data.list || []).map(item => ({ id: item.user_id, name: `AdsPower ${item.user_id}` }));
  } catch (apiError) {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-File', path.join(__dirname, 'find-cdp.ps1')],
      { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    const detected = JSON.parse(stdout.replace(/^\uFEFF/, '').trim() || '[]');
    const processes = Array.isArray(detected) ? detected : [detected];
    const profiles = [];
    for (const process of processes) {
      if (!Number.isInteger(process.port) || process.port < 1 || process.port > 65535) continue;
      if (profiles.some(profile => profile.id === `cdp:${process.port}`)) continue;
      try {
        const response = await fetch(`http://127.0.0.1:${process.port}/json/version`, { signal: AbortSignal.timeout(1500) });
        const version = await response.json();
        if (version.webSocketDebuggerUrl) profiles.push({ id: `cdp:${process.port}`, name: `${process.name} · PID ${process.pid} · cổng ${process.port}` });
      } catch { /* The port is not a local CDP browser. */ }
    }
    if (!profiles.length) throw new Error(`${apiError.message} Không thấy profile có cổng CDP đang mở; hãy mở profile AdsPower hoặc bật Local API.`);
    return profiles;
  }
}

async function connectionFor(profileId, apiKey) {
  const cached = connections.get(profileId);
  if (cached?.isConnected()) return cached;
  let endpoint;
  if (/^cdp:\d+$/.test(profileId)) endpoint = `http://127.0.0.1:${profileId.slice(4)}`;
  else {
    const data = await adsRequest(apiKey, `/api/v1/browser/active?user_id=${encodeURIComponent(profileId)}`);
    if (data.status !== 'Active' || !data.ws?.puppeteer) throw new Error('Profile AdsPower chưa mở hoặc không có cổng điều khiển.');
    endpoint = data.ws.puppeteer;
  }
  const browser = await chromium.connectOverCDP(endpoint, { noDefaults: true, isLocal: true });
  connections.set(profileId, browser);
  return browser;
}

async function listTabs(profileId, apiKey) {
  const browser = await connectionFor(profileId, apiKey);
  const pages = browser.contexts().flatMap(context => context.pages());
  const result = [];
  for (const page of pages) {
    if (page.isClosed() || !/^https:\/\/business\.facebook\.com\//i.test(page.url())) continue;
    let id = [...tabs].find(([, value]) => value.page === page)?.[0];
    if (!id) { id = crypto.randomUUID(); tabs.set(id, { page, profileId }); }
    result.push({ id, title: await page.title().catch(() => 'Meta Business Suite'), url: page.url(),
      ready: /\/bulk_upload_composer(?:[/?#]|$)/.test(page.url()),
      assetId: new URL(page.url()).searchParams.get('asset_id') || '' });
  }
  return result;
}

function selectedPage(tabId) {
  const page = tabs.get(tabId)?.page;
  if (!page || page.isClosed()) throw new Error('Tab đã đóng. Hãy quét lại danh sách tab.');
  if (!/^https:\/\/business\.facebook\.com\/latest\/bulk_upload_composer(?:[/?#]|$)/i.test(page.url())) {
    throw new Error('Tab đã chọn không còn ở màn hình Bulk upload reels.');
  }
  return page;
}

async function validateFiles(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 50) throw new Error('Chọn từ 1 đến 50 hàng.');
  const seen = new Set();
  const result = [];
  for (const row of rows) {
    if (!Number.isSafeInteger(row.row) || row.row < 1) throw new Error('Số hàng không hợp lệ.');
    if (!row.file) throw new Error(`Hàng ${row.row} chưa có video.`);
    const file = await fs.realpath(row.file);
    const stat = await fs.stat(file);
    if (!stat.isFile() || !/\.(mp4|mov|m4v|webm|avi)$/i.test(file)) throw new Error(`Hàng ${row.row}: file video không hợp lệ.`);
    if (seen.has(file.toLowerCase())) throw new Error(`Video ${path.basename(file)} được gán cho nhiều hàng.`);
    seen.add(file.toLowerCase());
    result.push({ ...row, file, fileName: path.basename(file) });
  }
  return result;
}

async function uploadAll(page, rows) {
  const input = page.locator('input[type="file"][multiple][accept*="video"]').first();
  if (await input.count()) {
    await input.setInputFiles(rows.map(row => row.file));
    return;
  }
  const button = page.getByRole('button', { name: /Add videos/i }).first();
  await button.waitFor({ state: 'visible' });
  const chooserPromise = page.waitForEvent('filechooser');
  await button.click();
  const chooser = await chooserPromise;
  await chooser.setFiles(rows.map(row => row.file));
}

function uniquePrefix(fileName, allNames) {
  for (let size = 3; size <= fileName.length; size++) {
    const prefix = fileName.slice(0, size);
    if (allNames.filter(name => name.startsWith(prefix)).length === 1) return prefix;
  }
  return fileName;
}

function metaDate(value) {
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (slash) return new Date(Date.UTC(Number(slash[3]), Number(slash[2]) - 1, Number(slash[1])));
  const local = new Date(value);
  return new Date(Date.UTC(local.getFullYear(), local.getMonth(), local.getDate()));
}

async function inspectCards(page) {
  return page.evaluate(() => {
    const selector = 'textarea[placeholder*="Describe"], [role="textbox"][contenteditable="true"]';
    const descriptions = [...document.querySelectorAll(selector)];
    return descriptions.map((field, index) => {
      let root = field;
      let found = false;
      while (root.parentElement && root !== document.body) {
        root = root.parentElement;
        const hasSchedule = [...root.querySelectorAll('button, [role="button"]')]
          .some(button => /Scheduling options|Publish now/i.test(button.textContent || ''));
        if (hasSchedule && root.querySelectorAll(selector).length === 1) {
          found = true;
          break;
        }
      }
      if (!found) return null;
      root.setAttribute('data-meta-suite-fill-card', String(index));
      const hints = [...root.querySelectorAll('[title], [aria-label]')]
        .flatMap(node => [node.getAttribute('title'), node.getAttribute('aria-label')]).filter(Boolean);
      return { index, text: (root.innerText || '').slice(0, 700), hints: hints.slice(0, 30) };
    }).filter(Boolean);
  });
}

function matchCards(rows, cards) {
  if (cards.length < rows.length) return null;
  const allNames = rows.map(row => row.fileName);
  const assigned = new Set();
  const mapping = [];
  for (const row of rows) {
    const prefix = uniquePrefix(row.fileName, allNames);
    const matches = cards.filter(card => !assigned.has(card.index) &&
      [card.text, ...card.hints].some(text => text.includes(row.fileName) || text.includes(prefix)));
    if (matches.length !== 1) {
      throw new Error(`Không ghép chắc chắn video ${row.fileName} với dòng Meta. Kiểm tra tên file hiển thị trên trang rồi thử lại.`);
    }
    assigned.add(matches[0].index);
    mapping.push({ ...row, cardIndex: matches[0].index });
  }
  return mapping;
}

async function fillCaptions(page, mapping) {
  for (const row of mapping) {
    const root = page.locator(`[data-meta-suite-fill-card="${row.cardIndex}"]`);
    const description = root.locator(DESCRIPTION).first();
    await description.fill(caption(row.title, row.description));
    const title = root.locator('textarea:not([placeholder*="Describe"])').first();
    if (await title.count()) await title.fill(shortTitle(row.title));
  }
}

async function removeUploaded(page, rows, onRemoved) {
  for (const row of [...rows].sort((a, b) => b.cardIndex - a.cardIndex)) {
    const cards = await inspectCards(page);
    const card = cards.find(item => item.index === row.cardIndex);
    if (!card) throw new Error(`Không còn thấy video của hàng ${row.row}; kiểm tra tab Meta trước khi xóa tiếp.`);
    const root = page.locator(`[data-meta-suite-fill-card="${row.cardIndex}"]`);
    const content = await root.locator(DESCRIPTION).first().evaluate(field => 'value' in field ? field.value : field.textContent);
    if (content !== caption(row.title, row.description) &&
        ![card.text, ...card.hints].some(text => text.includes(row.fileName))) {
      throw new Error(`Không xác nhận được video của hàng ${row.row}; chưa xóa để tránh nhầm dòng.`);
    }
    const remove = root.getByRole('button', { name: /^(delete|remove|trash|xóa|gỡ)( video| reel| clip)?$/i });
    const icon = root.locator('button[aria-label*="delete" i], button[aria-label*="remove" i], button[title*="delete" i], button[title*="remove" i], button:has(svg[class*="trash" i]), button:has(svg[data-icon*="trash" i])');
    const button = await remove.count() === 1 ? remove : icon;
    if (await button.count() !== 1) throw new Error(`Không nhận diện chắc nút xóa video hàng ${row.row} trên Meta; hãy xóa trực tiếp trên trang.`);
    await button.click();
    let gone = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      if ((await inspectCards(page)).length < cards.length) { gone = true; break; }
      const confirm = page.getByRole('dialog').getByRole('button', { name: /^(delete|remove|xóa|gỡ)( video| reel| clip)?$/i }).last();
      if (await confirm.isVisible().catch(() => false)) await confirm.click();
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    if (!gone) throw new Error(`Meta chưa xác nhận đã xóa video hàng ${row.row}; kiểm tra trang trước khi thử lại.`);
    onRemoved(row);
  }
}

async function prepareSchedule(page, row) {
  const cards = await inspectCards(page);
  const card = cards.find(card => card.index === row.cardIndex);
  if (!card) throw new Error(`Không còn thấy video của hàng ${row.row}.`);
  const root = page.locator(`[data-meta-suite-fill-card="${row.cardIndex}"]`);
  const update = page.getByRole('button', { name: 'Update', exact: true }).last();
  if (!await update.isVisible().catch(() => false)) {
    const menu = root.getByRole('button', { name: /Scheduling options|Publish now/i }).first();
    await menu.click();
  }
  await page.getByRole('button', { name: 'Schedule', exact: true }).last().click();
  await update.waitFor({ state: 'visible' });
  const zoneText = (await page.locator('text=/(Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific)\\/[A-Za-z_]+/').last().textContent().catch(() => '')) || '';
  const timezone = zoneText.match(/(?:Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific)\/[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)*/)?.[0] || '';
  const [year, month, day] = row.date.split('-').map(Number);
  const [hour, minute] = row.time.split(':').map(Number);
  const dateInput = page.locator('input[placeholder="dd/mm/yyyy"]:visible').last();
  const hours = page.locator('input[aria-label="hours"]:visible').last();
  const minutes = page.locator('input[aria-label="minutes"]:visible').last();
  if (!await dateInput.count() || !await hours.count() || !await minutes.count()) {
    throw new Error('Không nhận diện được ô ngày/giờ trong Meta; chưa bấm Update.');
  }
  const currentText = await dateInput.inputValue();
  const current = metaDate(currentText);
  if (Number.isNaN(current.getTime())) throw new Error(`Không đọc được ngày hiện tại của Meta: ${currentText}`);
  const months = (year - current.getUTCFullYear()) * 12 + month - (current.getUTCMonth() + 1);
  if (!await page.getByRole('button', { name: /Next month/i }).isVisible().catch(() => false)) await dateInput.click();
  const direction = months >= 0 ? /Next month/i : /Previous month/i;
  for (let i = 0; i < Math.abs(months); i++) await page.getByRole('button', { name: direction }).click();
  const monthName = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, 1)));
  await page.getByRole('button', { name: new RegExp(`\\b${day} ${monthName} ${year}\\b`) }).click();
  for (const [field, value] of [[hours, hour], [minutes, minute]]) {
    await field.click();
    await field.press('ControlOrMeta+A');
    await field.pressSequentially(String(value).padStart(2, '0'));
    await field.press('Tab');
    if (Number(await field.getAttribute('aria-valuenow')) !== value) throw new Error('Meta không giữ giờ vừa điền.');
  }
  const chosenText = await dateInput.inputValue();
  const chosenDate = metaDate(chosenText);
  if (Number.isNaN(chosenDate.getTime()) || chosenDate.getUTCDate() !== day || chosenDate.getUTCMonth() + 1 !== month || chosenDate.getUTCFullYear() !== year) {
    throw new Error('Meta không giữ ngày vừa chọn.');
  }
  return { date: chosenText, time: row.time, timezone };
}

async function preparePublishNow(page, row) {
  const cards = await inspectCards(page);
  if (!cards.some(card => card.index === row.cardIndex)) throw new Error(`Không còn thấy video của hàng ${row.row}.`);
  const root = page.locator(`[data-meta-suite-fill-card="${row.cardIndex}"]`);
  const update = page.getByRole('button', { name: 'Update', exact: true }).last();
  if (!await update.isVisible().catch(() => false)) {
    await root.getByRole('button', { name: /Scheduling options|Publish now/i }).first().click();
  }
  const options = page.getByRole('button', { name: 'Schedule', exact: true }).last().locator('xpath=..');
  const publishNow = options.getByRole('button', { name: 'Publish now', exact: true });
  if (await publishNow.count() !== 1) throw new Error('Không nhận diện chắc tùy chọn Đăng ngay trên Meta; chưa bấm Update.');
  await publishNow.click();
  await update.waitFor({ state: 'visible' });
  return {};
}

module.exports = { listProfiles, listTabs, selectedPage, validateFiles, uploadAll, inspectCards, matchCards, fillCaptions, removeUploaded, prepareSchedule, preparePublishNow };
