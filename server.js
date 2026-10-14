const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const sheets = require('./sheets');
const meta = require('./meta');
const { parsePattern } = require('./public/schedule');

const execFileAsync = promisify(execFile);
const host = '127.0.0.1';
const port = Number(process.env.PORT) || 38917;
const origin = `http://${host}:${port}`;
const dataPath = process.env.DATA_PATH || path.join(__dirname, 'user-data.json');
const jobs = new Map();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function json(res, code, value) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function body(req) {
  let value = '';
  for await (const chunk of req) {
    value += chunk;
    if (value.length > 1024 * 1024) throw new Error('Yêu cầu quá lớn.');
  }
  return JSON.parse(value || '{}');
}

async function readData() {
  try { return JSON.parse(await fs.readFile(dataPath, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { presets: {}, settings: {} }; throw error; }
}

async function saveData(data) {
  const temporary = `${dataPath}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(temporary, dataPath);
}

let dataWrite = Promise.resolve();
function updateData(change) {
  const next = dataWrite.then(async () => {
    const data = await readData();
    data.presets ||= {};
    data.settings ||= {};
    const result = change(data);
    await saveData(data);
    return result;
  });
  dataWrite = next.catch(() => {});
  return next;
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function publicJob(job) {
  return { id: job.id, stage: job.stage, message: job.message, current: job.current,
    timeZone: job.timeZone, preset: job.preset,
    rows: job.rows.map(row => ({ row: row.row, title: row.title, fileName: row.fileName, mode: row.mode, date: row.date, time: row.time })),
    cards: job.stage === 'needsMapping' ? job.cards.map(card => ({ index: card.index, text: card.text.slice(0, 120) })) : undefined };
}

async function fillJob(job, mapping) {
  job.rows = mapping;
  job.stage = 'filling';
  job.message = 'Đang điền tiêu đề và mô tả...';
  await meta.fillCaptions(job.page, mapping);
  job.current = 0;
  if (mapping.length === 1 && mapping[0].mode === 'now') {
    try {
      await meta.preparePublishNow(job.page, mapping[0]);
      job.stage = 'awaitingUpdate';
      job.message = `Hàng ${mapping[0].row}: đã chọn Đăng ngay. Bạn tự bấm Update và Publish trên Meta.`;
      return;
    } catch (error) {
      job.message = `Hàng ${mapping[0].row}: ${error.message} Bấm Thử lại Đăng ngay trong Tiến trình nếu cần.`;
    }
  } else {
    job.message = 'Đã điền nội dung. Bấm điền giờ từng hàng; bạn tự bấm Update trên Meta.';
  }
  job.stage = 'ready';
}

async function runJob(job) {
  try {
    const before = await meta.inspectCards(job.page);
    job.stage = 'uploading';
    job.message = `Đang đưa ${job.rows.length} video vào Meta cùng lúc...`;
    await meta.uploadAll(job.page, job.rows);
    job.message = 'Đang chờ Meta hiện đủ dòng video...';
    while (!job.cancelled) {
      if (job.page.isClosed()) throw new Error('Tab Meta đã đóng.');
      const cards = await meta.inspectCards(job.page);
      if (cards.length >= before.length + job.rows.length) {
        try {
          const mapping = meta.matchCards(job.rows, cards);
          if (mapping) { await fillJob(job, mapping); return; }
        } catch (error) {
          job.cards = cards;
          job.stage = 'needsMapping';
          job.message = `${error.message} Hãy ghép các dòng Meta với hàng Sheets trong tool.`;
          return;
        }
      }
      await sleep(2000);
    }
    job.stage = 'cancelled';
    job.message = 'Đã dừng tool. Video đã chọn có thể vẫn đang tải lên trong tab Meta.';
  } catch (error) {
    job.stage = 'error';
    job.message = error.message;
  }
}

function assertSchedule(row) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(row.time)) {
    throw new Error(`Hàng ${row.row}: ngày hoặc giờ không hợp lệ.`);
  }
  const [year, month, day] = row.date.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.toISOString().slice(0, 10) !== row.date) throw new Error(`Hàng ${row.row}: ngày không hợp lệ.`);
}

async function pickFiles(single = false) {
  const { videoDirectory } = await readData();
  const args = ['-NoProfile', '-STA', '-File', path.join(__dirname, 'pick-files.ps1')];
  if (single) args.push('-Single');
  if (videoDirectory) args.push('-InitialDirectory', videoDirectory);
  const { stdout } = await execFileAsync('powershell.exe', args,
    { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  const files = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
  const selected = Array.isArray(files) ? files : [files];
  if (selected.length) await updateData(data => { data.videoDirectory = path.win32.dirname(selected[0]); });
  return selected;
}

async function handleApi(req, res, route) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Chỉ nhận POST.' });
  if (req.headers.origin !== origin || !req.headers['content-type']?.startsWith('application/json')) {
    return json(res, 403, { error: 'Yêu cầu không đến từ giao diện local.' });
  }
  const input = await body(req);
  if (route === '/api/read') return json(res, 200, { rows: await sheets.readSheetRows(input) });
  if (route === '/api/profiles') return json(res, 200, { profiles: await meta.listProfiles(input.apiKey) });
  if (route === '/api/tabs') return json(res, 200, { tabs: await meta.listTabs(input.profileId, input.apiKey) });
  if (route === '/api/pick') return json(res, 200, { files: await pickFiles(input.single === true) });
  if (route === '/api/presets') return json(res, 200, await readData());
  if (route === '/api/config') {
    const source = input.settings || {};
    const limits = { sheetUrl: 2048, sheetTab: 150, rowList: 500, titleColumn: 3, descriptionColumn: 3, startDate: 10, pattern: 500 };
    const settings = {};
    for (const [key, limit] of Object.entries(limits)) {
      if (typeof source[key] !== 'string' || source[key].length > limit) throw new Error(`Cấu hình ${key} không hợp lệ.`);
      settings[key] = source[key].trim();
    }
    if (settings.startDate && !validDate(settings.startDate)) throw new Error('Ngày bắt đầu không hợp lệ.');
    if (settings.pattern) settings.pattern = parsePattern(settings.pattern).pattern;
    await updateData(data => { data.settings = settings; });
    return json(res, 200, { settings });
  }
  if (route === '/api/preset') {
    if (!/^\d{5,30}$/.test(input.assetId || '')) throw new Error('Tab chưa có asset_id hợp lệ.');
    const pattern = parsePattern(input.pattern || input.slots).pattern;
    const zone = String(input.timeZone || '').trim();
    try { if (zone) new Intl.DateTimeFormat('en-US', { timeZone: zone }); }
    catch { throw new Error('Múi giờ không hợp lệ, ví dụ Asia/Saigon.'); }
    const startDate = String(input.startDate || '').trim();
    if (startDate && !validDate(startDate)) throw new Error('Ngày bắt đầu không hợp lệ.');
    const preset = { timeZone: zone, pattern, startDate };
    await updateData(data => { data.presets[input.assetId] = preset; });
    return json(res, 200, { preset });
  }
  if (route === '/api/start') {
    const page = meta.selectedPage(input.tabId);
    const active = [...jobs.values()].find(job => job.page === page && !['error', 'cancelled', 'done', 'replaced', 'cleared'].includes(job.stage));
    if (active && ['starting', 'uploading', 'filling', 'clearing'].includes(active.stage)) {
      throw new Error('Video của lượt trước vẫn đang được xử lý trên Meta. Đợi bước đó xong rồi bấm lại.');
    }
    const rows = await meta.validateFiles(input.rows);
    rows.forEach(row => {
      row.mode ||= 'schedule';
      if (!['schedule', 'now'].includes(row.mode)) throw new Error(`Hàng ${row.row}: cách đăng không hợp lệ.`);
      if (row.mode === 'schedule') assertSchedule(row);
    });
    const assetId = new URL(page.url()).searchParams.get('asset_id') || '';
    const pattern = rows.some(row => row.mode === 'schedule') && input.pattern ? parsePattern(input.pattern).pattern : '';
    if (active) {
      active.stage = 'replaced';
      active.message = 'Lượt cũ đã được thay bằng lượt mới trên cùng tab Meta.';
    }
    const job = { id: randomUUID(), page, rows, assetId, pattern, startDate: validDate(input.startDate) ? input.startDate : (rows.find(row => row.mode === 'schedule')?.date || ''),
      stage: 'starting', message: 'Đang chuẩn bị...', current: 0, cancelled: false };
    jobs.set(job.id, job);
    void runJob(job);
    return json(res, 200, { job: publicJob(job) });
  }
  const job = jobs.get(input.jobId);
  if (!job) return json(res, 404, { error: 'Lượt điền không còn trên máy chủ.' });
  if (route === '/api/job') return json(res, 200, { job: publicJob(job) });
  if (route === '/api/cancel') {
    job.cancelled = true;
    return json(res, 200, { job: publicJob(job) });
  }
  if (route === '/api/clear') {
    if (!['ready', 'awaitingUpdate', 'clearError'].includes(job.stage) || !job.rows.every(row => Number.isInteger(row.cardIndex))) {
      throw new Error('Chỉ xóa được video của lượt điền đã ghép xong với Meta.');
    }
    job.stage = 'clearing';
    job.message = 'Đang xóa video của lượt này trên Meta...';
    try {
      await meta.removeUploaded(job.page, job.rows, row => {
        job.rows = job.rows.filter(item => item !== row);
        job.current = 0;
      });
      job.stage = 'cleared';
      job.message = 'Đã xóa video của lượt này khỏi Meta. Có thể chọn lại video hoặc đưa lại vào Meta.';
    } catch (error) {
      job.stage = 'clearError';
      job.message = `Chưa xóa hết video: ${error.message}`;
      throw error;
    }
    return json(res, 200, { job: publicJob(job) });
  }
  if (route === '/api/map') {
    if (job.stage !== 'needsMapping') throw new Error('Không có dòng nào cần ghép.');
    const indices = input.indices;
    const allowed = new Set(job.cards.map(card => card.index));
    if (!Array.isArray(indices) || indices.length !== job.rows.length || new Set(indices).size !== indices.length ||
      indices.some(index => !allowed.has(index))) throw new Error('Ghép video không hợp lệ.');
    await fillJob(job, job.rows.map((row, i) => ({ ...row, cardIndex: indices[i] })));
    return json(res, 200, { job: publicJob(job) });
  }
  if (route === '/api/schedule') {
    if (!['ready', 'awaitingUpdate'].includes(job.stage)) throw new Error('Chưa đến bước điền lịch.');
    if (job.stage === 'awaitingUpdate') {
      const update = job.page.getByRole('button', { name: 'Update', exact: true }).last();
      if (await update.isVisible().catch(() => false)) throw new Error('Nút Update vẫn đang mở. Bạn tự bấm Update trên Meta rồi mới tiếp tục.');
      job.current++;
    }
    if (job.current >= job.rows.length) {
      job.stage = 'done';
      job.message = 'Đã điền hết. Bạn kiểm tra lại và tự bấm Publish trên Meta.';
      return json(res, 200, { job: publicJob(job) });
    }
    const row = job.rows[job.current];
    try {
      const value = row.mode === 'now' ? await meta.preparePublishNow(job.page, row) : await meta.prepareSchedule(job.page, row);
      if (value.timezone) {
        job.timeZone = value.timezone;
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: value.timezone });
          if (/^\d{5,30}$/.test(job.assetId)) {
            job.preset = await updateData(data => {
              const previous = data.presets[job.assetId];
              const pattern = previous?.pattern || (Array.isArray(previous?.slots) ? previous.slots.join(', ') : job.pattern);
              if (!pattern) return previous;
              const preset = { timeZone: value.timezone, pattern: parsePattern(pattern).pattern,
                startDate: previous?.startDate || job.startDate || '' };
              data.presets[job.assetId] = preset;
              return preset;
            });
          }
        } catch { /* Scheduling is already filled; preset persistence must not block review. */ }
      }
      job.stage = 'awaitingUpdate';
      job.message = row.mode === 'now'
        ? `Hàng ${row.row}: đã chọn Đăng ngay. Bạn tự bấm Update trên Meta, rồi bấm Tiếp trong tool. Publish cuối trang vẫn do bạn quyết định.`
        : `Hàng ${row.row}: đã điền ${value.date} ${value.time}${value.timezone ? ` (${value.timezone})` : ''}. Bạn tự bấm Update trên Meta, rồi bấm Tiếp trong tool.`;
    } catch (error) {
      job.stage = 'ready';
      job.message = `Hàng ${row.row}: ${error.message}`;
      throw error;
    }
    return json(res, 200, { job: publicJob(job) });
  }
  return json(res, 404, { error: 'Không tìm thấy API.' });
}

const staticFiles = { '/': 'index.html', '/app.js': 'app.js', '/schedule.js': 'schedule.js', '/style.css': 'style.css' };
http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/api/')) return await handleApi(req, res, req.url.split('?')[0]);
    const name = staticFiles[req.url];
    if (!name) { res.writeHead(404); return res.end(); }
    const type = name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html';
    const file = await fs.readFile(path.join(__dirname, 'public', name));
    res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
    res.end(file);
  } catch (error) {
    json(res, 400, { error: error.message });
  }
}).listen(port, host, () => console.log(`Meta Suite Fill: ${origin}`));
