const fs = require('node:fs/promises');

function spreadsheetId(url) {
  const match = /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([\w-]+)/.exec(String(url).trim());
  if (!match) throw new Error('Link Google Sheets không đúng định dạng.');
  return match[1];
}

function columnIndex(letter) {
  const value = String(letter).trim().toUpperCase();
  if (!/^[A-Z]{1,3}$/.test(value)) throw new Error('Cột phải là chữ cái, ví dụ D hoặc F.');
  return [...value].reduce((index, char) => index * 26 + char.charCodeAt(0) - 64, 0) - 1;
}

function columnLetter(index) {
  let value = index + 1;
  let result = '';
  while (value) {
    value--;
    result = String.fromCharCode(65 + value % 26) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function parseCsv(csv) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const char = csv[i];
    if (quoted) {
      if (char === '"' && csv[i + 1] === '"') { value += '"'; i++; }
      else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"' && value === '') quoted = true;
    else if (char === ',') { row.push(value); value = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && csv[i + 1] === '\n') i++;
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
    } else value += char;
  }
  if (quoted) throw new Error('Dữ liệu CSV từ Sheets chưa hoàn chỉnh.');
  if (row.length || value) { row.push(value); rows.push(row); }
  return rows;
}

function parseRowList(value) {
  const rows = [];
  const seen = new Set();
  const tokens = String(value).trim().replace(/\s*[-–]\s*/g, '-').split(/[,;\s]+/).filter(Boolean);
  if (!tokens.length) throw new Error('Nhập hàng cần điền, ví dụ 2,4-6.');
  for (const token of tokens) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(token);
    if (!match) throw new Error(`Hàng "${token}" không hợp lệ.`);
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : start;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end - start > 49) {
      throw new Error(`Khoảng hàng "${token}" không hợp lệ (tối đa 50 hàng).`);
    }
    for (let row = start; row <= end; row++) {
      if (!seen.has(row)) {
        if (rows.length === 50) throw new Error('Mỗi lượt tối đa 50 hàng.');
        seen.add(row);
        rows.push(row);
      }
    }
  }
  return rows.sort((a, b) => a - b);
}

function shortTitle(title) {
  const text = String(title || '').trim();
  const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text);
  return [...segments].slice(0, 200).map(part => part.segment).join('');
}

function stripLinks(value) {
  const markdownLink = /\[[^\]\r\n]+\]\(\s*(?:https?:\/\/|www\.)[^)\s]+\s*\)/giu;
  const url = /(?<![\p{L}\p{N}_@])(?:https?:\/\/|www\.)[^\s<>"'()]+|(?<![\p{L}\p{N}_@])(?:[a-z0-9-]+\.)+(?:com|net|org|vn|io|me|tv|co|gg|ly|info|biz|link|site|pro|xyz|app|page|store|watch|be|ee|ai|fm|cc|us|uk|id|jp)\b(?::\d+)?(?:\/[^\s<>"'()]*)?/giu;
  return String(value || '')
    .replace(markdownLink, '')
    .replace(url, match => match.match(/[.,!?;:]+$/)?.[0] || '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([.,!?;:])/g, '$1')
    .replace(/[ \t]+\r?\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function caption(title, description) {
  return [shortTitle(title), stripLinks(description)].filter(Boolean).join('\n\n');
}

async function resolveLocalDescription(value) {
  const match = /^\s*\[FILE\s+([^\]\r\n]+)\]/i.exec(value);
  if (!match) return value;
  const path = match[1].trim();
  if (!/\.(txt|md)$/i.test(path)) throw new Error('File mô tả phải là .txt hoặc .md.');
  const stat = await fs.stat(path);
  if (!stat.isFile() || stat.size > 10 * 1024 * 1024) throw new Error('File mô tả phải nhỏ hơn 10 MB.');
  return fs.readFile(path, 'utf8');
}

async function readSheetRow({ sheetUrl, sheetTab, titleColumn, descriptionColumn, rowNumber }) {
  const id = spreadsheetId(sheetUrl);
  const titleIndex = columnIndex(titleColumn);
  const descriptionIndex = columnIndex(descriptionColumn);
  const row = Number(rowNumber);
  if (!Number.isSafeInteger(row) || row < 1) throw new Error('Hàng không hợp lệ.');
  if (!String(sheetTab).trim()) throw new Error('Nhập tên tab trong Sheets.');
  const endColumn = columnLetter(Math.max(titleIndex, descriptionIndex));
  const url = new URL(`https://docs.google.com/spreadsheets/d/${id}/gviz/tq`);
  url.searchParams.set('tqx', 'out:csv');
  url.searchParams.set('sheet', sheetTab.trim());
  url.searchParams.set('range', `A${row}:${endColumn}${row}`);
  url.searchParams.set('headers', '0');
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const csv = await response.text();
  if (!response.ok || !response.headers.get('content-type')?.includes('text/csv') || /^\s*</.test(csv)) {
    throw new Error('Không đọc được Sheets. Kiểm tra link, tên tab và quyền xem bằng liên kết.');
  }
  const cells = parseCsv(csv)[0];
  if (!cells) throw new Error(`Hàng ${row} trống.`);
  const title = (cells[titleIndex] || '').trim();
  const description = stripLinks(await resolveLocalDescription(cells[descriptionIndex] || ''));
  if (!title && !description) throw new Error(`Hàng ${row} không có tiêu đề hoặc mô tả.`);
  return { row, title, description, caption: caption(title, description) };
}

async function readSheetRows(settings) {
  const numbers = parseRowList(settings.rowList);
  const rows = new Array(numbers.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, numbers.length) }, async () => {
    while (next < numbers.length) {
      const index = next++;
      rows[index] = await readSheetRow({ ...settings, rowNumber: numbers[index] });
    }
  }));
  return rows;
}

module.exports = { spreadsheetId, columnIndex, parseCsv, parseRowList, shortTitle, stripLinks, caption, readSheetRows };
