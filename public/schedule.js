(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Schedule = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function parsePattern(value) {
    const source = String(value || '').trim();
    if (!source) throw new Error('Nhập ít nhất một giờ, ví dụ 19,21,23 | 7,9.');
    const groups = source.split('|');
    const days = [];
    for (const group of groups) {
      const tokens = group.split(/[\s,;]+/).filter(Boolean);
      if (!tokens.length) throw new Error('Mỗi ngày sau dấu | cần ít nhất một giờ.');
      let times = [];
      let previous = -1;
      for (const token of tokens) {
        const match = /^(\d{1,2})(?:(?::|h)(\d{1,2}))?h?$/i.exec(token);
        if (!match) throw new Error(`Giờ không hợp lệ: ${token}. Dùng 19, 19h hoặc 19:00.`);
        const hour = Number(match[1]);
        const minute = Number(match[2] || 0);
        if (hour > 23 || minute > 59) throw new Error(`Giờ không hợp lệ: ${token}.`);
        const ordinal = hour * 60 + minute;
        if (ordinal <= previous) { days.push(times); times = []; }
        times.push(`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
        previous = ordinal;
      }
      days.push(times);
    }
    const count = days.reduce((sum, day) => sum + day.length, 0);
    if (count > 50 || days.length > 31) throw new Error('Mẫu giờ tối đa 50 khung trong 31 ngày.');
    return { days, pattern: days.map(day => day.join(', ')).join(' | '), count };
  }

  function buildSchedule(start, pattern, count) {
    const parsed = typeof pattern === 'string' ? parsePattern(pattern) : pattern;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(start));
    if (!match) throw new Error('Chọn ngày bắt đầu hợp lệ.');
    const base = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    if (base.toISOString().slice(0, 10) !== start) throw new Error('Chọn ngày bắt đầu hợp lệ.');
    const slots = parsed.days.flatMap((times, day) => times.map(time => ({ day, time })));
    return Array.from({ length: count }, (_, index) => {
      const slot = slots[index % slots.length];
      const day = Math.floor(index / slots.length) * parsed.days.length + slot.day;
      const date = new Date(base);
      date.setUTCDate(date.getUTCDate() + day);
      return { date: date.toISOString().slice(0, 10), time: slot.time };
    });
  }

  return { parsePattern, buildSchedule };
});
