const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { spawn } = require('node:child_process');

test('lượt đã điền xong không khóa tab cho lượt kế tiếp', async () => {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const code = `
    const target = require.resolve('./meta');
    const page = { url: () => 'https://business.facebook.com/latest/bulk_upload_composer?asset_id=123456', isClosed: () => false };
    let uploaded = false;
    require.cache[target] = { id: target, filename: target, loaded: true, exports: {
      selectedPage: () => page,
      validateFiles: async rows => rows.map(row => ({ ...row, fileName: 'video.mp4' })),
      inspectCards: async () => uploaded ? [{ index: 0, text: 'video.mp4', hints: [] }] : [],
      uploadAll: async () => { uploaded = true; },
      matchCards: rows => rows.map(row => ({ ...row, cardIndex: 0 })),
      fillCaptions: async () => {},
      preparePublishNow: async () => ({})
    } };
    require('./server');
  `;
  const child = spawn(process.execPath, ['-e', code], { cwd: __dirname, env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
  const origin = `http://127.0.0.1:${port}`;
  const post = async (route, body) => {
    const response = await fetch(`${origin}/api/${route}`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  try {
    let ready = false;
    for (let i = 0; i < 30; i++) {
      try { ready = (await fetch(origin)).ok; if (ready) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, 'server thử nghiệm không khởi động');
    const input = { tabId: 'tab', rows: [{ row: 3, file: 'video.mp4', mode: 'now' }] };
    const first = await post('start', input);
    assert.equal(first.status, 200);
    let stage;
    for (let i = 0; i < 30; i++) {
      stage = (await post('job', { jobId: first.data.job.id })).data.job.stage;
      if (stage === 'awaitingUpdate') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(stage, 'awaitingUpdate');
    const second = await post('start', input);
    assert.equal(second.status, 200, second.data.error);
    assert.equal((await post('job', { jobId: first.data.job.id })).data.job.stage, 'replaced');
  } finally { child.kill(); }
});
