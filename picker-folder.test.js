const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

test('chọn nhiều video mở lại thư mục video vừa chọn', async () => {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const dataPath = path.join(os.tmpdir(), `meta-picker-${process.pid}-${Date.now()}.json`);
  const file = 'D:\\Videos\\3.mp4';
  const code = `
    const { promisify } = require('node:util');
    const stub = () => {};
    stub[promisify.custom] = async (exe, args) => {
      process.send({ args });
      return { stdout: JSON.stringify([${JSON.stringify(file)}]), stderr: '' };
    };
    require('node:child_process').execFile = stub;
    require('./server');
  `;
  const child = spawn(process.execPath, ['-e', code], {
    cwd: __dirname, env: { ...process.env, PORT: String(port), DATA_PATH: dataPath },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc']
  });
  const calls = [];
  child.on('message', message => calls.push(message.args));
  const origin = `http://127.0.0.1:${port}`;
  const post = async (route, input = {}) => {
    const response = await fetch(`${origin}/api/${route}`, {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(input)
    });
    return { status: response.status, data: await response.json() };
  };
  try {
    let ready = false;
    for (let i = 0; i < 30; i++) {
      try { ready = (await fetch(origin)).ok; if (ready) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, 'server thử nghiệm không khởi động');
    const first = await post('pick', { single: true });
    assert.equal(first.status, 200, first.data.error);
    const second = await post('pick');
    assert.equal(second.status, 200, second.data.error);
    assert.equal(calls.length, 2);
    const index = calls[1].indexOf('-InitialDirectory');
    assert.ok(index >= 0, 'lần chọn nhiều video không nhận thư mục từ lần chọn trước');
    assert.equal(calls[1][index + 1], 'D:\\Videos');
    assert.equal((await post('presets')).data.videoDirectory, 'D:\\Videos');
  } finally {
    child.kill();
    await fs.rm(dataPath, { force: true });
  }
});
