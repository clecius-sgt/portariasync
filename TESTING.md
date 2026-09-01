# Leitura local e captura automática

## Instalação

Node.js 22 ou superior. Execute `npm ci` para instalar versões fixadas no
`package-lock.json` e preparar os arquivos locais de reconhecimento em `vendor/`.
Não há chave, conta ou assinatura para leitura de etiquetas. A instalação inicial
baixa pacotes do npm; durante a leitura, o navegador busca os arquivos no próprio
servidor do PortariaSync. Não envia a imagem a um fornecedor de OCR.

## Testes

- `npm test`: identificação do destinatário, respostas antigas, falhas de OCR,
  baixa confiança, estabilidade, movimento, cancelamento e captura única.
- `node tests/browser-ocr.cjs`: requer Playwright e Chromium. Usa o motor Tesseract
  real, um QR de teste, uma etiqueta desenhada e câmera virtual via canvas.
  Testa as telas de 1366 × 900 e 390 × 844, sem servidor de produção, gravação de
  encomendas ou notificações. `CHROMIUM_PATH` permite informar outro executável.
  `SCREENSHOT_DIR` salva imagens de conferência. O teste bloqueia requisições
  externas e verifica que o reconhecimento usa somente arquivos do servidor local.

Não colocar fotos de moradores, chaves ou dados de produção nos testes.
A câmera virtual verifica o fluxo, mas não substitui o teste no celular usado na
portaria, com iluminação, foco e etiquetas reais.

## Validação da implementação inicial

Validação concluída: 54 testes de lógica e o teste de navegador nas duas dimensões
acima. O motor local leu corretamente o texto da etiqueta sintética; a câmera
virtual capturou sem clique, o QR foi decodificado, o cadastro divergente foi
bloqueado e o cadastro sintético correto foi selecionado. Nenhuma requisição de
OCR externo, gravação de encomenda ou notificação ocorreu.
Não foi executado teste com a câmera física ou com o banco em produção.

## Regras

- A câmera verifica contraste, detalhes e estabilidade por pelo menos 1,2 segundo.
  Depois lê uma imagem em memória e exige texto compatível com etiqueta, incluindo
  endereço e nome ou informação de envio. O processo não depende de o morador
  já estar cadastrado. Movimento durante a leitura descarta o resultado.
- A foto aceita é a mesma analisada pelo OCR, sem novo disparo nem segunda leitura.
  Capturar não registra a encomenda nem envia WhatsApp. O operador ainda revisa o
  cadastro e usa o comando de registro já existente.
- O morador só é selecionado quando nome completo e endereço coincidem com um
  cadastro sem ambiguidade, respeitando apartamento/bloco e confiança do OCR.
  Erros, nomes parciais ou endereços divergentes exigem confirmação.
- O indicador de confiança do motor é uma heurística, não uma probabilidade de
  acerto nem garantia de identidade. Limiares iniciais: 65 para aceitar a captura,
  75 para permitir a seleção automática após conferir nome e endereço.
- O texto deve estar legível, na posição correta, e ocupar boa parte do quadro.
  A interface orienta reposicionamento; o botão Capturar agora e a escolha de foto
  continuam disponíveis quando necessário. Não há garantia de leitura de toda etiqueta.
- Uma aba oculta, navegação, logout ou fechamento da câmera interrompe a captura.
  Resultados anteriores não podem preencher um cadastro novo.
- O leitor nativo de códigos é usado quando disponível; ZXing local cobre os demais
  navegadores. Se o código não for decodificado, o texto impresso é lido pelo OCR.

## Atualização do VPS

Depois de integrar esta alteração ao `main`, no diretório já instalado:

```bash
cd /root/portariasync
git pull --ff-only origin main
npm ci
npm test
```

Reinicie o processo Node pelo mesmo gerenciador usado na instalação atual.
Esta alteração também modifica `server.js`; apenas recarregar a página não basta.
Se a aplicação é iniciada manualmente, reinicie com `npm start`. Se usa PM2 ou
systemd, reinicie o processo/serviço existente, sem iniciar uma segunda instância.
Depois use Ctrl+F5 ou feche e reabra a página no celular.

Se o Git informar alterações locais ou divergência, inspecione antes de continuar;
não use reset para descartar arquivos do servidor. Não há migração de moradores
ou alteração do banco. Preserve `.env` e `data/`.

A câmera automática exige HTTPS, exceto em localhost. Em acesso HTTP pelo IP do
VPS, o navegador pode permitir selecionar uma foto, mas não a câmera contínua.
A primeira leitura baixa o modelo do próprio servidor e pode levar mais tempo.
O tempo das leituras seguintes depende do aparelho e da imagem.

O endpoint antigo `/api/ocr` retorna 410 e pede atualização da página. A cópia
legada `INDEX~1.HTM` é bloqueada pelo servidor para não reativar o leitor antigo.

## Fontes técnicas

- https://github.com/naptha/tesseract.js
- https://github.com/naptha/tesseract.js/blob/master/docs/local-installation.md
- https://github.com/zxing-js/library
- https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia

## Diagnóstico de falha imediata no celular (2026-09-01.2)

O cadastro inclui o link **Testar leitor neste aparelho**, também disponível em
`/diagnostico-leitor.html`. A página lê uma etiqueta fictícia usando o mesmo
`LocalOCR` da aplicação, informa endereço, navegador, versão do leitor, etapa,
tempo e erro recebido. Não consulta moradores, não registra encomendas e não
transmite fotos. O resultado só é copiado quando o operador usa o botão.

A câmera agora prepara o leitor antes de iniciar a análise dos quadros. O
progresso aparece acima do vídeo. Falhas de inicialização permanecem visíveis;
não se abre a câmera nativa como se o problema fosse permissão de câmera.
Erros retornados como texto pelo Tesseract são preservados junto com a etapa.

Validação desta atualização: 63 testes de lógica aprovados, incluindo
inicialização, cancelamento durante a preparação, erro em texto, script ausente,
progresso, recuperação e prevenção de associação incorreta. A verificação no
navegador remoto não pôde acessar o servidor local de teste. O diagnóstico no
Chrome do JOVI J2507 e a captura com câmera física ainda precisam ser executados;
a causa da falha específica nesse aparelho ainda não foi identificada.
