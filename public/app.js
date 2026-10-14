const $ = id => document.getElementById(id);
const state = { rows: [], files: [], tabs: [], tab: null, presets: {}, settings: {}, settingsLoaded: false, jobId: null, lastStage: '' };

function notice(message, good = false) {
  $('notice').textContent = message;
  $('notice').className = good ? 'ok' : '';
}

async function api(route, data = {}) {
  const response = await fetch(`/api/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return result;
}

function option(value, label) {
  const item = document.createElement('option');
  item.value = value;
  item.textContent = label;
  return item;
}

function cell(parent, content) {
  const td = parent.insertCell();
  if (content instanceof Node) td.append(content);
  else td.textContent = content;
  return td;
}

function fields() {
  return { sheetUrl: $('sheetUrl').value, sheetTab: $('sheetTab').value,
    rowList: $('rowList').value, titleColumn: $('titleColumn').value, descriptionColumn: $('descriptionColumn').value };
}

let settingsTimer;
let settingsWrite = Promise.resolve();
function currentSettings() {
  let pattern = state.settings.pattern || '19:00, 21:00, 23:00 | 07:00, 09:00';
  try { pattern = Schedule.parsePattern($('slots').value).pattern; } catch { /* Save the last valid pattern. */ }
  return { ...fields(), startDate: $('startDate').value, pattern };
}

function queueSettingsSave() {
  if (!state.settingsLoaded) return;
  clearTimeout(settingsTimer);
  $('settingsStatus').textContent = 'Đang tự lưu cấu hình Sheets...';
  settingsTimer = setTimeout(() => {
    const settings = currentSettings();
    settingsWrite = settingsWrite.catch(() => {}).then(() => api('config', { settings })).then(result => {
      state.settings = result.settings;
      $('settingsStatus').textContent = 'Đã tự lưu Sheets và cấu hình dùng gần nhất trên máy.';
    }).catch(error => { $('settingsStatus').textContent = `Chưa lưu được cấu hình: ${error.message}`; });
  }, 350);
}

let presetTimer;
let presetWrite = Promise.resolve();
function persistPreset(values) {
  const next = presetWrite.catch(() => {}).then(() => api('preset', values));
  presetWrite = next.catch(() => {});
  return next;
}
function queuePresetSave() {
  updatePatternPreview();
  queueSettingsSave();
  if (!state.tab?.assetId) return;
  clearTimeout(presetTimer);
  const assetId = state.tab.assetId;
  const values = { assetId, timeZone: $('timeZone').value, pattern: $('slots').value, startDate: $('startDate').value };
  presetTimer = setTimeout(async () => {
    try {
      const result = await persistPreset(values);
      state.presets[assetId] = result.preset;
      if (state.tab?.assetId === assetId) updatePatternPreview();
    } catch (error) { if (state.tab?.assetId === assetId) $('presetStatus').textContent = `Chưa lưu mẫu giờ: ${error.message}`; }
  }, 500);
}

function assignFiles() {
  const used = new Set();
  for (const row of state.rows) {
    const match = state.files.find(file => !used.has(file) && new RegExp(`^0*${row.row}[_ -]`).test(file.split(/[\\/]/).pop()));
    if (match) { row.file = match; used.add(match); }
  }
  let index = 0;
  for (const row of state.rows) {
    if (row.file) continue;
    while (used.has(state.files[index])) index++;
    row.file = state.files[index] || '';
    if (row.file) used.add(row.file);
  }
}

function drawRows() {
  const tbody = $('rows');
  tbody.replaceChildren();
  if (!state.rows.length) { const tr = tbody.insertRow(); const td = cell(tr, 'Đọc Sheets để hiện các hàng.'); td.colSpan = 6; td.className = 'empty'; return; }
  for (const row of state.rows) {
    const tr = tbody.insertRow();
    cell(tr, String(row.row));
    const summary = document.createElement('div');
    const title = document.createElement('div'); title.className = 'title'; title.textContent = row.title || '(không có tiêu đề)';
    const desc = document.createElement('div'); desc.className = 'desc'; desc.textContent = row.description || '';
    summary.append(title, desc); cell(tr, summary);
    const select = document.createElement('select');
    select.append(option('', '— Chọn video —'));
    for (const file of state.files) select.append(option(file, file.split(/[\\/]/).pop()));
    select.value = row.file || '';
    select.addEventListener('change', () => { row.file = select.value; updateStart(); });
    const videoCell = document.createElement('div');
    videoCell.className = 'video-cell';
    const pick = document.createElement('button');
    pick.className = 'secondary';
    pick.textContent = 'Chọn 1';
    pick.setAttribute('aria-label', `Chọn video cho hàng ${row.row}`);
    pick.addEventListener('click', () => act(() => pickSingle(row)));
    videoCell.append(select, pick);
    cell(tr, videoCell);
    const date = document.createElement('input'); date.type = 'date'; date.value = row.date || ''; date.addEventListener('change', () => { row.date = date.value; updateStart(); }); cell(tr, date);
    const time = document.createElement('input'); time.type = 'time'; time.value = row.time || ''; time.addEventListener('change', () => { row.time = time.value; updateStart(); }); cell(tr, time);
    const actions = document.createElement('div'); actions.className = 'row-actions';
    for (const [mode, label] of [['schedule', 'Hẹn giờ'], ['now', 'Đăng ngay']]) {
      const button = document.createElement('button');
      button.className = mode === 'now' ? 'start-now' : 'start-schedule secondary';
      button.textContent = label;
      button.setAttribute('aria-label', `${label} hàng ${row.row}`);
      button.addEventListener('click', () => act(() => startRows([row], mode)));
      actions.append(button);
    }
    cell(tr, actions);
  }
  updateStart();
}

function updateStart() {
  const available = state.tab?.ready && !state.jobId;
  $('start').disabled = !available || !state.rows.length || state.rows.some(row => !row.file || !row.date || !row.time);
  document.querySelectorAll('.start-schedule').forEach((button, index) => {
    const row = state.rows[index];
    button.disabled = !available || !row?.file || !row.date || !row.time;
  });
  document.querySelectorAll('.start-now').forEach((button, index) => {
    button.disabled = !available || !state.rows[index]?.file;
  });
}

function applyPreset() {
  const start = $('startDate').value;
  const schedule = Schedule.buildSchedule(start, $('slots').value, state.rows.length);
  schedule.forEach((slot, i) => { state.rows[i].date = slot.date; state.rows[i].time = slot.time; });
  drawRows();
  notice('Đã áp giờ vào từng hàng; bạn có thể sửa từng ô.', true);
}

async function readRows() {
  const result = await api('read', fields());
  state.rows = result.rows.map(row => ({ ...row, file: '', date: '', time: '' }));
  assignFiles();
  if ($('startDate').value) applyPreset(); else drawRows();
  notice(`Đã đọc ${state.rows.length} hàng.`, true);
}

async function scanProfiles() {
  const result = await api('profiles', { apiKey: $('apiKey').value.trim() });
  const select = $('profile');
  select.replaceChildren(option('', 'Chọn profile'));
  result.profiles.forEach(profile => select.append(option(profile.id, profile.name)));
  if (result.profiles.length === 1) select.value = result.profiles[0].id;
  notice(`Đã thấy ${result.profiles.length} profile AdsPower đang mở.`, true);
  if (result.profiles.length === 1) await scanTabs();
}

async function scanTabs() {
  await presetsReady;
  if (!$('profile').value) throw new Error('Chọn profile AdsPower trước.');
  const result = await api('tabs', { profileId: $('profile').value, apiKey: $('apiKey').value.trim() });
  state.tabs = result.tabs;
  const select = $('tab');
  select.replaceChildren(option('', 'Chọn tab'));
  result.tabs.forEach(tab => select.append(option(tab.id, `${tab.ready ? '✓' : '·'} ${tab.title} — ${tab.assetId || tab.url}`)));
  const ready = result.tabs.filter(tab => tab.ready);
  if (ready.length === 1) select.value = ready[0].id;
  chooseTab();
  notice(`Đã thấy ${result.tabs.length} tab Meta trong profile.`, true);
}

function storedPattern(preset) {
  return preset?.pattern || (Array.isArray(preset?.slots) ? preset.slots.join(', ') : '');
}

function updatePatternPreview() {
  try {
    const parsed = Schedule.parsePattern($('slots').value);
    const schedule = Schedule.buildSchedule($('startDate').value, parsed, parsed.count);
    let first = 0;
    $('patternPreview').textContent = parsed.days.map(times => {
      const iso = schedule[first].date;
      first += times.length;
      return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}: ${times.join(' · ')}`;
    }).join('  |  ') + ` · Lặp mỗi ${parsed.days.length} ngày.`;
  } catch (error) { $('patternPreview').textContent = error.message; }
  const preset = state.presets[state.tab?.assetId];
  const current = `${$('timeZone').value.trim()}\n${$('slots').value.trim()}`;
  let saved = '';
  if (preset) {
    try { saved = `${preset.timeZone}\n${Schedule.parsePattern(storedPattern(preset)).pattern}`; }
    catch { saved = `${preset.timeZone}\n${storedPattern(preset)}`; }
  }
  let normalized = current;
  try { normalized = `${$('timeZone').value.trim()}\n${Schedule.parsePattern($('slots').value).pattern}`; }
  catch { /* keep the typed value visible until corrected */ }
  $('presetStatus').textContent = !state.tab?.assetId
    ? 'Chọn Page để lưu mẫu giờ riêng; ngày bắt đầu mặc định là hôm nay.'
    : !preset ? 'Page này chưa có lịch đã lưu. Múi giờ tự nhận từ Meta khi điền.'
      : saved === normalized ? (preset.timeZone ? 'Đã lưu mẫu giờ và múi giờ Meta cho Page này.' : 'Đã lưu mẫu giờ cho Page này. Múi giờ sẽ tự nhận từ Meta khi điền.')
        : 'Đang tự lưu thay đổi lịch cho Page này...';
}

function chooseTab() {
  state.tab = state.tabs.find(tab => tab.id === $('tab').value) || null;
  $('tabInfo').textContent = state.tab ? `${state.tab.ready ? 'Sẵn sàng' : 'Cần mở Bulk upload reels'} · ${state.tab.url}` : 'Chỉ tab Bulk upload reels được dùng để điền.';
  $('pageName').textContent = state.tab?.assetId ? `Page ID ${state.tab.assetId}` : 'Chưa chọn Page';
  const preset = state.presets[state.tab?.assetId];
  $('timeZone').value = preset?.timeZone || '';
  $('slots').value = storedPattern(preset) || state.settings.pattern || '19,21,23 | 7,9';
  updatePatternPreview();
  queuePresetSave();
  updateStart();
}

async function pickFiles() {
  const result = await api('pick');
  if (!result.files.length) return;
  state.files = result.files;
  state.rows.forEach(row => { row.file = ''; });
  assignFiles();
  $('fileCount').textContent = `${state.files.length} video; kiểm tra lại ghép hàng bên dưới.`;
  drawRows();
}

async function pickSingle(row) {
  const result = await api('pick', { single: true });
  if (!result.files.length) return;
  const file = result.files[0];
  if (!state.files.includes(file)) state.files.push(file);
  row.file = file;
  $('fileCount').textContent = `${state.files.length} video đã chọn; kiểm tra ghép hàng bên dưới.`;
  drawRows();
}

async function savePreset() {
  if (!state.tab?.assetId) throw new Error('Chọn tab có Page ID trước.');
  clearTimeout(presetTimer);
  const assetId = state.tab.assetId;
  const result = await persistPreset({ assetId, timeZone: $('timeZone').value,
    pattern: $('slots').value, startDate: $('startDate').value });
  state.presets[assetId] = result.preset;
  if (state.tab?.assetId === assetId) {
    $('slots').value = result.preset.pattern;
    updatePatternPreview();
  }
  notice('Đã lưu mẫu giờ cho Page này trên máy. Ngày sẽ mặc định là hôm nay ở lần mở sau.', true);
}

async function startRows(rows, mode = 'schedule') {
  const tab = state.tab;
  if (mode === 'schedule') await savePreset();
  if (state.tab !== tab) throw new Error('Tab Meta đã thay đổi trong lúc chuẩn bị. Kiểm tra lại rồi bấm điền.');
  const result = await api('start', { tabId: tab.id, rows: rows.map(row => ({ ...row, mode })),
    pattern: $('slots').value, startDate: $('startDate').value });
  state.jobId = result.job.id;
  $('jobSection').hidden = false;
  renderJob(result.job);
  updateStart();
}

async function start() { await startRows(state.rows); }

function renderMapping(job) {
  const host = $('mapping');
  host.replaceChildren();
  host.hidden = job.stage !== 'needsMapping';
  if (host.hidden) return;
  const selects = [];
  for (const row of job.rows) {
    const label = document.createElement('label');
    label.textContent = `Hàng ${row.row}: ${row.fileName}`;
    const select = document.createElement('select');
    select.append(option('', 'Chọn dòng Meta'));
    for (const card of job.cards) select.append(option(String(card.index), `Dòng ${card.index + 1}: ${card.text.replace(/\s+/g, ' ').slice(0, 80)}`));
    label.append(select); host.append(label); selects.push(select);
  }
  const button = document.createElement('button');
  button.textContent = 'Xác nhận ghép và điền nội dung';
  button.addEventListener('click', () => act(async () => {
    const indices = selects.map(select => Number(select.value));
    if (selects.some(select => !select.value)) throw new Error('Ghép đủ từng hàng với dòng Meta.');
    const result = await api('map', { jobId: state.jobId, indices });
    renderJob(result.job);
  }));
  host.append(button);
}

function renderJob(job) {
  $('jobStage').textContent = job.stage;
  $('jobMessage').textContent = job.message;
  if (job.timeZone && state.tab?.assetId) {
    $('timeZone').value = job.timeZone;
    if (job.preset) state.presets[state.tab.assetId] = job.preset;
    updatePatternPreview();
  }
  const next = $('scheduleNext');
  next.hidden = !['ready', 'awaitingUpdate'].includes(job.stage);
  const action = row => row?.mode === 'now' ? `Thử lại Đăng ngay hàng ${row.row}` : `Điền giờ hàng ${row?.row || ''}`;
  if (!next.hidden) next.textContent = job.stage === 'awaitingUpdate'
    ? `Đã bấm Update → ${job.current + 1 < job.rows.length ? action(job.rows[job.current + 1]) : 'xong'}`
    : action(job.rows[job.current]);
  $('cancel').hidden = !['starting', 'uploading'].includes(job.stage);
  $('clearVideos').hidden = !['ready', 'awaitingUpdate', 'clearError'].includes(job.stage);
  if (job.stage !== state.lastStage) renderMapping(job);
  state.lastStage = job.stage;
  if (['done', 'cleared', 'replaced'].includes(job.stage)) { state.jobId = null; updateStart(); }
}

async function clearVideos() {
  if (!confirm('Xóa các video của lượt điền này khỏi tab Meta? Nội dung và giờ đã điền cho chúng cũng sẽ mất.')) return;
  renderJob((await api('clear', { jobId: state.jobId })).job);
}

async function pollJob() {
  if (!state.jobId) return;
  try { renderJob((await api('job', { jobId: state.jobId })).job); }
  catch (error) { handleError(error); }
}

function handleError(error) {
  if (error.status === 404 && state.jobId) {
    state.jobId = null;
    state.lastStage = '';
    state.rows = [];
    $('jobStage').textContent = 'Đã kết thúc';
    $('jobMessage').textContent = 'Lượt điền cũ đã mất sau khi tool khởi động lại. Kiểm tra các video và lịch đang có trên Meta trước khi đọc hàng và bắt đầu lượt mới.';
    $('scheduleNext').hidden = true;
    $('cancel').hidden = true;
    $('clearVideos').hidden = true;
    $('mapping').hidden = true;
    drawRows();
  }
  notice(error.message);
}

async function act(fn) {
  try { await fn(); }
  catch (error) { handleError(error); }
}

function on(id, fn) { $(id).addEventListener('click', () => act(fn)); }
on('readRows', readRows);
on('scanProfiles', scanProfiles);
on('scanTabs', scanTabs);
on('pickFiles', pickFiles);
on('applyPreset', async () => applyPreset());
on('savePreset', savePreset);
on('start', start);
on('scheduleNext', async () => renderJob((await api('schedule', { jobId: state.jobId })).job));
on('clearVideos', clearVideos);
on('cancel', async () => renderJob((await api('cancel', { jobId: state.jobId })).job));
$('tab').addEventListener('change', chooseTab);
$('profile').addEventListener('change', () => { state.tab = null; $('tab').replaceChildren(option('', 'Chưa chọn')); updatePatternPreview(); updateStart(); });
for (const id of ['sheetUrl', 'sheetTab', 'rowList', 'titleColumn', 'descriptionColumn']) {
  $(id).addEventListener('input', queueSettingsSave);
}
$('slots').addEventListener('input', queuePresetSave);
$('startDate').addEventListener('change', queuePresetSave);
const today = new Date();
$('startDate').value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
updatePatternPreview();
const presetsReady = api('presets').then(result => {
  state.presets = result.presets || {};
  state.settings = result.settings || {};
  for (const id of ['sheetUrl', 'sheetTab', 'rowList', 'titleColumn', 'descriptionColumn']) {
    if (typeof state.settings[id] === 'string') $(id).value = state.settings[id];
  }
  if (state.settings.pattern) $('slots').value = state.settings.pattern;
  state.settingsLoaded = true;
  $('settingsStatus').textContent = 'Cấu hình Sheets và lịch dùng gần nhất được tự lưu trên máy.';
  updatePatternPreview();
}).catch(error => { $('settingsStatus').textContent = `Không tải được cấu hình: ${error.message}`; });
setInterval(pollJob, 2000);
