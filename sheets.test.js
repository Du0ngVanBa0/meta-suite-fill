const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCsv, parseRowList, shortTitle, caption } = require('./sheets');
const { matchCards, fillCaptions } = require('./meta');

test('CSV giữ dấu phẩy, dấu nháy và xuống dòng trong mô tả', () => {
  assert.deepEqual(parseCsv('"A, B","Dòng 1\nDòng 2"\r\n"A ""quote""",C'),
    [['A, B', 'Dòng 1\nDòng 2'], ['A "quote"', 'C']]);
});

test('danh sách hàng được sắp tăng và bỏ trùng', () => {
  assert.deepEqual(parseRowList('7, 3-5, 4'), [3, 4, 5, 7]);
  assert.throws(() => parseRowList('1-51'), /50 hàng/);
});

test('tiêu đề 200 ký tự không cắt giữa emoji và mô tả giữ nguyên', () => {
  const title = 'A'.repeat(199) + '👩‍💻' + 'B';
  assert.equal(shortTitle(title), 'A'.repeat(199) + '👩‍💻');
  assert.equal(caption(title, 'Mô tả\ndòng hai'), `${'A'.repeat(199)}👩‍💻\n\nMô tả\ndòng hai`);
});

test('xóa link Page khác khỏi mô tả nhưng giữ nội dung và dấu câu', () => {
  const description = [
    'Một câu chuyện mới. Xem tại https://facebook.com/other/page?ref=1.',
    'Nguồn: www.instagram.com/other/ hoặc fb.watch/abc123!',
    'Đọc tiếp [trang này](https://example.com/post).',
    'Liên hệ email name@example.com vẫn là chữ thường. Wait.Stop'
  ].join('\n');
  assert.equal(caption('Tiêu đề', description), [
    'Tiêu đề', '',
    'Một câu chuyện mới. Xem tại.',
    'Nguồn: hoặc!',
    'Đọc tiếp.',
    'Liên hệ email name@example.com vẫn là chữ thường. Wait.Stop'
  ].join('\n'));
});

test('ô Meta nhận caption đã lọc dù hàng được đọc trước khi cập nhật tool', async () => {
  const filled = [];
  const page = { locator: () => ({ locator: selector => ({ first: () => selector.startsWith('textarea:not')
    ? { count: async () => 1, fill: async value => filled.push(['title', value]) }
    : { fill: async value => filled.push(['description', value]) } }) }) };
  await fillCaptions(page, [{ cardIndex: 0, title: 'Tiêu đề', description: 'Nội dung https://other-page.com/post',
    caption: 'Tiêu đề\n\nNội dung https://other-page.com/post' }]);
  assert.deepEqual(filled, [['description', 'Tiêu đề\n\nNội dung'], ['title', 'Tiêu đề']]);
});

test('ghép card theo tên file dù Meta đảo thứ tự hiển thị', () => {
  const rows = [
    { row: 2, fileName: '2_Create_story.mp4' },
    { row: 3, fileName: '3_Create_story.mp4' }
  ];
  const cards = [
    { index: 1, text: '3_Create...\n45%\nPublish now', hints: [] },
    { index: 0, text: '2_Create...\n50%\nPublish now', hints: [] }
  ];
  assert.deepEqual(matchCards(rows, cards).map(row => row.cardIndex), [0, 1]);
});
