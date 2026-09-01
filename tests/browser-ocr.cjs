// Real local OCR + virtual camera. No production server, data, or notifications.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

(async () => {
  const root = path.join(__dirname, '..');
  const effects = [], assets = [], external = [];
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.gz': 'application/gzip' };
  const server = http.createServer((req, res) => {
    if (req.url === '/api/users') { res.setHeader('Content-Type', 'application/json'); return res.end('{"users":[]}'); }
    if (req.url.startsWith('/api/')) { effects.push(req.url); res.setHeader('Content-Type', 'application/json'); return res.end('{"ok":true}'); }
    const filename = path.join(root, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
    if (!fs.existsSync(filename) || fs.statSync(filename).isDirectory()) { res.statusCode = 404; return res.end(); }
    assets.push(req.url);
    res.setHeader('Content-Type', mime[path.extname(filename)] || 'application/octet-stream');
    fs.createReadStream(filename).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    for (const viewport of [{ width: 1366, height: 900 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport });
      await context.route('**/*', route => {
        const url = route.request().url();
        if (url.startsWith(origin) || url.startsWith('data:')) return route.continue();
        external.push(url); return route.abort();
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(origin);
      await page.waitForFunction(() => backendAuthDisponivel && window.LocalOCR && window.ZXing);
      await page.evaluate(() => {
        document.getElementById('loginScreen').style.display = 'none';
        document.getElementById('page-registrar').classList.add('active');
        usuarioLogado = { id: 'test', nome: 'Teste', perfil: 'admin' };
        authToken = 'local-test-token';
        selecionarMorador('1087');
        const canvas = document.createElement('canvas');
        canvas.width = 1280; canvas.height = 720;
        window.testCanvas = canvas;
        window.drawLabel = () => {
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = 'white'; ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = 'black'; ctx.font = '42px Arial';
          ['DESTINATARIO', 'Carlos Augusto', 'Rua Londres 160', 'CEP 15115000', 'TBR123456789'].forEach((line, i) => ctx.fillText(line, 90, 125 + i * 100));
        };
        drawLabel();
        const recognize = LocalOCR.recognize;
        window.ocrCount = 0;
        LocalOCR.recognize = (...args) => { ocrCount++; return recognize(...args).then(r => { window.lastOCR = r; return r; }); };
        // Exercise the free JS barcode fallback even on browsers with native support.
        window.BarcodeDetector = undefined;
        navigator.mediaDevices.getUserMedia = async () => {
          window.testStream = canvas.captureStream(10);
          window.drawTimer = setInterval(drawLabel, 100);
          return testStream;
        };
      });
      // Real barcode decoding independent of OCR. The QR payload is a tracking code.
      const barcode = await page.evaluate(async () => {
        const matrix = new ZXing.QRCodeWriter().encode('TBR123456789', ZXing.BarcodeFormat.QR_CODE, 500, 500, new Map());
        const c = document.createElement('canvas'); c.width = 600; c.height = 600;
        const ctx = c.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0,0,600,600); ctx.fillStyle = 'black';
        for(let y=0;y<500;y++) for(let x=0;x<500;x++) if(matrix.get(x,y)) ctx.fillRect(x+50,y+50,1,1);
        return detectarCodigoLivre(c.toDataURL());
      });
      assert.equal(barcode?.codigo, 'TBR123456789');
      // Click only OPEN CAMERA. Never click Capture.
      await page.locator('button[onclick="fotografarEtiqueta()"]').click();
      try {
        await page.waitForSelector('#modalSugestaoMorador', { timeout: 75000 });
      } catch (error) {
        console.error(await page.evaluate(() => ({ status: document.getElementById('uniStatus').textContent,
          ocr: document.getElementById('ocrStatus').textContent, count: ocrCount, last: window.lastOCR,
          video: [uniVideo.readyState, uniVideo.videoWidth, uniVideo.videoHeight], hidden: document.hidden,
          camera: document.getElementById('modalUnificado').style.display })));
        throw error;
      }
      console.log('Captured OCR:', await page.evaluate(() => lastOCR));
      assert.equal(await page.locator('#nomeLidoSugestao').textContent(), 'Carlos Augusto');
      assert.match(await page.locator('#enderecoLidoSugestao').textContent(), /Londres.*160/);
      assert.equal(await page.evaluate(() => moradorSelecionadoId), null);
      assert.equal(await page.locator('#inputCodigo').inputValue(), 'TBR123456789');
      assert.equal(await page.evaluate(() => ocrCount), 1, 'Reuse OCR from the same automatic snapshot');
      assert.equal(await page.evaluate(() => testStream.getTracks().every(t => t.readyState === 'ended')), true);
      await page.evaluate(() => registrarEncomenda());
      assert.equal(await page.evaluate(() => encomendas.length), 0);
      assert.deepEqual(effects, []);
      const bounds = await page.locator('#modalSugestaoMorador > div').boundingBox();
      assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width);
      assert.ok(bounds.y + bounds.height <= viewport.height);
      if (process.env.SCREENSHOT_DIR) {
        fs.mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, 'ocr-' + viewport.width + '.png') });
      }
      await page.locator('#filtroSugestaoMorador').fill('<img src=x onerror=alert(1)>');
      assert.equal(await page.locator('#listaSugestoesModal img').count(), 0);
      await page.locator('#filtroSugestaoMorador').fill('Creusa');
      await page.locator('#listaSugestoesModal button').click();
      assert.equal(await page.evaluate(() => moradorSelecionadoId), '1087');
      assert.match(await page.locator('#ocrStatus').textContent(), /manualmente/);
      // Re-read the image with a synthetic matching resident in isolated test state.
      await page.evaluate(async () => {
        moradores.push({ id: 'test-carlos', nome: 'Carlos Augusto', casa: 'Rua Londres 160' });
        await processarImagemEtiqueta(testCanvas.toDataURL());
      });
      assert.equal(await page.evaluate(() => moradorSelecionadoId), 'test-carlos');
      assert.match(await page.locator('#ocrStatus').textContent(), /Nome completo e endereço conferidos/);
      assert.deepEqual(effects, []);
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ viewport, realLocalOCR: await page.evaluate(() => lastOCR), automaticCapture: true, mismatchBlocked: true, exactMatch: true, barcode: barcode.codigo, errors }));
      await context.close();
    }
    assert.ok(assets.some(a => a.endsWith('por.traineddata.gz')));
    assert.ok(assets.some(a => a.endsWith('.wasm.js')));
    assert.ok(external.every(url => url.startsWith('https://fonts.googleapis.com/')), 'No external OCR, barcode license, or CDN requests');
    assert.ok(!effects.includes('/api/ocr'));
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
