const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareSchedule } = require('./meta');

test('schedule follows timezone shown by Meta even when stored timezone differs', async () => {
  const input = (value, current) => ({
    last() { return this; },
    async count() { return 1; },
    async inputValue() { return value; },
    async click() {},
    async press() {},
    async pressSequentially() {},
    async getAttribute() { return String(current); },
  });
  const date = input('13/10/2026');
  const hours = input('', 19);
  const minutes = input('', 0);
  const button = { last() { return this; }, first() { return this; }, async click() {},
    async waitFor() {}, async isVisible() { return true; } };
  const update = { ...button, async isVisible() { return false; } };
  const page = {
    async evaluate() { return [{ index: 0 }]; },
    locator(selector) {
      if (selector.startsWith('[data-meta-suite-fill-card')) return { getByRole() { return button; } };
      if (selector.startsWith('text=')) return { ...button, async textContent() { return 'Asia/Jakarta'; } };
      if (selector.includes('dd/mm/yyyy')) return date;
      if (selector.includes('hours')) return hours;
      if (selector.includes('minutes')) return minutes;
      throw new Error(`Unexpected selector: ${selector}`);
    },
    getByRole(_role, options) { return options.name === 'Update' ? update : button; },
  };
  const result = await prepareSchedule(page, { row: 174, cardIndex: 0, date: '2026-10-13', time: '19:00' }, 'Asia/Saigon');
  assert.equal(result.timezone, 'Asia/Jakarta');
  assert.equal(result.time, '19:00');
});
