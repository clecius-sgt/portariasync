// Optional browser smoke test: requires Playwright and its Chromium browser.
// LABEL_IMAGE and OCRSPACE_API_KEY enable a real OCR request; otherwise OCR is mocked.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const root = path.join(__dirname, '..');
  const browser = await chromium.launch({ headless: true });
  const screenshots = process.env.SCREENSHOT_DIR;
  try {
    for (const viewport of [{ width: 1366, height: 900 }, { width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport });
      const errors = [];
      const effects = [];
      let response = { ParsedResults: [{ ParsedText: 'Carlos Augusto\nRua Londres 160\nTBR123456789' }] };
      let realText = '';
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== 'http://portaria.test') return route.abort();
        if (url.pathname === '/api/users') return route.fulfill({ json: { users: [] } });
        if (url.pathname === '/api/ocr') {
          if (process.env.LABEL_IMAGE) {
            assert.ok(process.env.OCRSPACE_API_KEY, 'OCRSPACE_API_KEY required for live OCR');
            const body = route.request().postDataJSON();
            const data = new FormData();
            for (const [k, v] of Object.entries({ base64Image: body.base64Image, language: 'por', scale: 'true', detectOrientation: 'true', OCREngine: '2' })) data.append(k, v);
            const result = await fetch('https://api.ocr.space/parse/image', {
              method: 'POST', headers: { apikey: process.env.OCRSPACE_API_KEY }, body: data,
              signal: AbortSignal.timeout(40000)
            });
            assert.ok(result.ok);
            response = await result.json();
            assert.equal(response.IsErroredOnProcessing, false);
            realText = response.ParsedResults.map(p => p.ParsedText).join('\n');
          }
          return route.fulfill({ json: response });
        }
        if (url.pathname.startsWith('/api/')) {
          effects.push(url.pathname);
          return route.fulfill({ json: { ok: true } });
        }
        if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'index.html')) });
        if (url.pathname === '/recipient-matching.js') return route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(root, 'recipient-matching.js')) });
        return route.fulfill({ status: 404, body: '' });
      });
      await page.goto('http://portaria.test');
      await page.waitForFunction(() => backendAuthDisponivel);
      await page.evaluate(() => {
        document.getElementById('loginScreen').style.display = 'none';
        document.getElementById('page-registrar').classList.add('active');
        usuarioLogado = { id: 'test', nome: 'Teste', perfil: 'admin' };
        authToken = 'local-test-token';
        // Barcode SDK is independent of recipient matching and not exercised here.
        detectarCodigoDynamsoft = async () => null;
        detectarMelhorCodigoBarras = async () => null;
        selecionarMorador('1087');
      });
      if (process.env.LABEL_IMAGE) {
        await page.locator('#inputFotoOCR').setInputFiles(process.env.LABEL_IMAGE);
      } else {
        await page.evaluate(() => processarImagemEtiqueta('data:image/png;base64,dGVzdA=='));
      }
      await page.waitForSelector('#modalSugestaoMorador', { timeout: 50000 });
      assert.equal(await page.locator('#nomeLidoSugestao').textContent(), 'Carlos Augusto');
      assert.match(await page.locator('#enderecoLidoSugestao').textContent(), /Londres.*160/);
      assert.match(await page.locator('#motivoSugestao').textContent(), /nome lido n/);
      assert.equal(await page.evaluate(() => moradorSelecionadoId), null);
      assert.equal(await page.locator('#inputCodigo').inputValue(), process.env.LABEL_IMAGE ? 'TBR364591209' : 'TBR123456789');
      await page.evaluate(() => registrarEncomenda());
      assert.equal(await page.evaluate(() => encomendas.length), 0);
      assert.equal(effects.length, 0, 'No writes or notifications before recipient confirmation');
      const bounds = await page.locator('#modalSugestaoMorador > div').boundingBox();
      assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width);
      assert.ok(bounds.y + bounds.height <= viewport.height);
      if (screenshots) {
        fs.mkdirSync(screenshots, { recursive: true });
        await page.screenshot({ path: path.join(screenshots, 'ocr-' + viewport.width + '.png') });
      }
      await page.locator('#filtroSugestaoMorador').fill('<img src=x onerror=alert(1)>');
      assert.equal(await page.locator('#listaSugestoesModal img').count(), 0);
      await page.locator('#filtroSugestaoMorador').fill('Creusa');
      await page.locator('#listaSugestoesModal button').click();
      assert.equal(await page.evaluate(() => moradorSelecionadoId), '1087');
      assert.match(await page.locator('#ocrStatus').textContent(), /manualmente/);
      assert.equal(effects.length, 0);
      // Synthetic record stays in this isolated browser only, never in production.
      await page.evaluate(() => moradores.push({ id: 'test-carlos', nome: 'Carlos Augusto', casa: 'Rua Londres 160' }));
      const successful = await page.evaluate(text => identificarMoradorOCR(text), realText || response.ParsedResults[0].ParsedText);
      assert.equal(successful.morador.id, 'test-carlos');
      await page.evaluate(() => {
        limparFormRegistrar();
        iniciarLeituraEtiqueta();
        document.getElementById('inputCodigo').value = 'TBR123456789';
        selecionarMorador('1087');
        return registrarEncomenda();
      });
      assert.equal(await page.evaluate(() => moradorSelecionadoId), null);
      assert.equal(await page.evaluate(() => encomendas.length), 0);
      assert.match(await page.locator('#toast').textContent(), /Aguarde/);
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ viewport, liveOCR: !!realText, readName: 'Carlos Augusto', mismatchBlocked: true, exactMatch: successful.morador.id, errors }));
      await page.close();
    }
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
