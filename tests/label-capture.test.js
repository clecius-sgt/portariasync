const test = require('node:test');
const assert = require('node:assert/strict');
const capture = require('../label-capture');
const label = { text: 'Carlos Augusto\nRua Londres 160\nTBR123456789', confidence: 95 };

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

function harness(result = label) {
  let clock = 0, tick, current = frame(), resolve;
  const received = [], messages = [];
  let calls = 0;
  const controller = capture.create({
    sample: () => current, snapshot: () => 'same-snapshot',
    recognize: () => { calls++; return new Promise(r => { resolve = r; }); },
    onCapture: (...args) => received.push(args), onStatus: text => messages.push(text),
    now: () => clock, schedule: fn => { tick = fn; return 1; }, unschedule: () => { tick = null; }
  });
  return { controller, received, messages, calls: () => calls,
    change: kind => { current = frame(kind); },
    step: (count = 1) => { for (let i = 0; i < count; i++) { clock += 180; if (tick) tick(); } },
    finish: async () => { resolve(result); await new Promise(r => setImmediate(r)); }
  };
}

test('blank and dark frames never trigger OCR or capture', () => {
  for (const type of ['blank', 'dark']) {
    const h = harness(); h.change(type); h.step(60);
    assert.equal(h.calls(), 0); assert.equal(h.received.length, 0);
  }
});
test('stable readable label captures exactly once, with the recognized snapshot', async () => {
  const h = harness(); h.step(4); assert.equal(h.calls(), 0);
  h.step(10); assert.equal(h.calls(), 1);
  await h.finish(); h.step(100);
  assert.equal(h.calls(), 1);
  assert.deepEqual(h.received, [['same-snapshot', label]]);
});
test('movement during OCR rejects stale snapshot even if camera stabilizes again', async () => {
  const h = harness(); h.step(15);
  h.change('blank'); h.step(); h.change('text'); h.step(15);
  await h.finish(); assert.equal(h.received.length, 0);
});
test('closing camera while reading prevents late capture', async () => {
  const h = harness(); h.step(15); h.controller.stop();
  await h.finish(); h.step(100); assert.equal(h.received.length, 0);
});
test('low confidence and ordinary text are not treated as a label', async () => {
  for (const result of [{ ...label, confidence: 40 }, { text: 'Um texto qualquer\nSem endereco', confidence: 95 }]) {
    const h = harness(result); h.step(15); await h.finish();
    assert.equal(h.received.length, 0);
    assert.match(h.messages.at(-1), /Aproxime/);
  }
});
test('unknown resident with legible address can be captured for manual review', () => {
  assert.equal(capture.looksLikeLabel({ text: 'Ana Pessoa\nRua Nova 999\nCEP 15115000', confidence: 90 }), true);
});

test('automatic OCR failure stays visible and never captures a label', async () => {
  let clock = 0, tick, progress;
  const messages = [], captures = [];
  const controller = capture.create({
    sample: () => frame(), snapshot: () => 'photo',
    recognize: async (image, onProgress) => {
      progress = onProgress;
      onProgress('Carregando idioma (50%)');
      throw 'Failed to construct Worker';
    },
    onStatus: text => messages.push(text), onCapture: (...args) => captures.push(args),
    now: () => clock, schedule: fn => { tick = fn; return 1; }, unschedule() {}
  });
  for (let i = 0; i < 15; i++) { clock += 180; tick(); }
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(messages.includes('Carregando idioma (50%)'));
  assert.match(messages.at(-1), /Failed to construct Worker/);
  for (let i = 0; i < 10; i++) { clock += 180; tick(); }
  assert.match(messages.at(-1), /Failed to construct Worker/);
  assert.equal(captures.length, 0);
  controller.stop();
  progress('Late progress');
  assert.match(messages.at(-1), /Failed to construct Worker/);
});
