const { test } = require('node:test');
const assert = require('node:assert/strict');
const { caption } = require('./sheets');
const { removeUploaded } = require('./meta');

function fakePage(initialCards, contents) {
  const cards = [...initialCards];
  const clicked = [];
  return {
    cards, clicked,
    evaluate: async () => cards.map((card, index) => ({ ...card, index })),
    locator(selector) {
      const index = Number(selector.match(/card="(\d+)"/)[1]);
      return {
        locator: query => query.includes('textarea')
          ? { first: () => ({ evaluate: async () => contents[cards[index].fileName] }) }
          : { count: async () => 0 },
        getByRole: () => ({ count: async () => 1, click: async () => { clicked.push(cards[index].fileName); cards.splice(index, 1); } }),
      };
    }
  };
}

test('xóa đúng các video đã ghép, từ dòng cuối để chỉ số không bị lệch', async () => {
  const rows = [
    { row: 3, cardIndex: 0, fileName: '3_video.mp4', title: 'Ba', description: 'Mô tả ba' },
    { row: 4, cardIndex: 1, fileName: '4_video.mp4', title: 'Bốn', description: 'Mô tả bốn' }
  ];
  const page = fakePage(rows.map(row => ({ fileName: row.fileName, text: row.fileName, hints: [] })),
    Object.fromEntries(rows.map(row => [row.fileName, caption(row.title, row.description)])));
  const removed = [];
  await removeUploaded(page, rows, row => removed.push(row.row));
  assert.deepEqual(page.clicked, ['4_video.mp4', '3_video.mp4']);
  assert.deepEqual(removed, [4, 3]);
});

test('không bấm xóa khi dòng Meta không khớp nội dung hoặc tên video', async () => {
  const row = { row: 3, cardIndex: 0, fileName: '3_video.mp4', title: 'Ba', description: 'Mô tả ba' };
  const page = fakePage([{ fileName: 'other.mp4', text: 'other.mp4', hints: [] }], { 'other.mp4': 'Bài khác' });
  await assert.rejects(removeUploaded(page, [row], () => {}), /chưa xóa để tránh nhầm dòng/);
  assert.deepEqual(page.clicked, []);
});
