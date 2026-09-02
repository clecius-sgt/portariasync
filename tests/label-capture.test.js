const test = require('node:test');
const assert = require('node:assert/strict');
const capture = require('../label-capture');

function frame(kind = 'text') {
  const width = 240, height = 135;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const v = kind === 'dark' ? 20 : kind === 'blank' ? 245 :
      (y % 18 > 7 && x % 13 > 6 ? 20 : 235);
    const p = (y * width + x) * 4;
    data.set([v, v, v, 255], p);
  }
  return { data, width, height };
}

test('manual capture mode never samples camera or starts OCR by itself', async () => {
  let samples = 0, snapshots = 0, reads = 0, captures = 0, schedules = 0;
  const messages = [];
  const controller = capture.create({
    sample: () => { samples++; return frame(); },
    snapshot: () => { snapshots++; return 'photo'; },
    recognize: async () => { reads++; return { text: 'Carlos Augusto\nRua Londres 160', confidence: 95 }; },
    onCapture: () => { captures++; },
    onStatus: text => messages.push(text),
    schedule: () => { schedules++; return 1; }
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(samples, 0);
  assert.equal(snapshots, 0);
  assert.equal(reads, 0);
  assert.equal(captures, 0);
  assert.equal(schedules, 0);
  assert.match(messages.at(-1), /Fotografar etiqueta/);
  controller.stop();
  assert.equal(controller.stopped, true);
});

test('automatic capture is explicitly disabled', () => {
  assert.equal(capture.automaticCapture, false);
  assert.equal(capture.nativePhotoCapture, true);
});

test('native photo mode opens the hidden capture input exactly once', () => {
  let clicks = 0;
  const input = { value: 'old-photo', click() { clicks++; } };
  const doc = {
    getElementById(id) { return id === 'inputFotoOCR' ? input : null; },
    querySelectorAll() { return []; }
  };
  const host = {};
  assert.equal(capture.installNativePhotoMode(doc, host), true);
  assert.equal(typeof host.fotografarEtiqueta, 'function');
  assert.equal(host.fotografarEtiqueta(), true);
  assert.equal(clicks, 1);
  assert.equal(input.value, '');
});

test('native photo mode fails closed when photo input is unavailable', () => {
  const doc = { getElementById() { return null; }, querySelectorAll() { return []; } };
  assert.equal(capture.installNativePhotoMode(doc, {}), false);
  assert.equal(capture.triggerNativePhotoInput(doc), false);
});

test('image quality measurement remains available for diagnostics', () => {
  const dark = frame('dark');
  const text = frame('text');
  assert.equal(capture.measure(dark.data, dark.width, dark.height).ready, false);
  const first = capture.measure(text.data, text.width, text.height);
  const second = capture.measure(text.data, text.width, text.height, first.gray);
  assert.equal(second.ready, true);
});

test('label validator remains available for post-photo diagnostics', () => {
  assert.equal(capture.looksLikeLabel({
    text: 'Carlos Augusto\nRua Londres 160\nCEP 15115000\nTBR364591209',
    confidence: 90
  }), true);
  assert.equal(capture.looksLikeLabel({ text: 'Um texto qualquer', confidence: 90 }), false);
});
