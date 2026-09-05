# PortariaSync em produção

## 1. Configurar chaves

Copie `.env.example` para `.env` e preencha:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`
- `ZAPI_URL`
- `ZAPI_CLIENT`
- `ADMIN_PASSWORD`

O arquivo `.env` não deve ser enviado ao GitHub.

Na primeira execução, o sistema cria o usuário `Administrador` com a senha definida em `ADMIN_PASSWORD`.

## 2. Criar tabela no Supabase

Antes do uso definitivo, execute o arquivo `supabase-schema.sql` no SQL Editor do Supabase.
Ele cria a tabela `app_state`, usada para espelhar celular e computador pelo banco.

## 3. Rodar o sistema

No terminal, dentro da pasta do sistema:

```bash
npm ci
npm start
```

Depois acesse:

```text
http://localhost:3000
```

## 4. Segurança

O `index.html` não deve conter service key, token da Z-API ou Client-Token.
Essas chaves ficam somente no backend (`server.js`) por meio do `.env`.

O backend bloqueia acesso direto a `.env`, arquivos ocultos e à pasta `data/`.
As rotas de dados, sincronização e WhatsApp exigem login com perfil permitido.

## 5. Login, usuários e sessões

Usuários e sessões ficam no banco global `data/access.sqlite`. As senhas usam hash
PBKDF2 e os tokens de sessão são gravados somente como SHA-256. O token bruto
existe apenas no navegador que iniciou a sessão.

Na primeira inicialização após a atualização, os usuários de `data/users.json`
são importados automaticamente, preservando identificadores, perfis, associações
e senhas existentes. O JSON permanece intacto como cópia legada e deixa de ser a
fonte ativa.

Por padrão:

- cada sessão expira após 8 horas;
- 5 tentativas incorretas bloqueiam temporariamente o usuário por 15 minutos;
- desativar um usuário ou trocar sua senha encerra todas as sessões dele;
- as sessões continuam válidas após reiniciar o processo principal.

Esses limites podem ser ajustados por `SESSION_MAX_AGE_MS`,
`ACCESS_MAX_LOGIN_ATTEMPTS` e `ACCESS_LOCK_MINUTES` no `.env`.

O painel administrativo está disponível em `/acessos.html`.

## 6. Dashboard Operacional

O painel em `/dashboard-operacional.html` reúne a situação atual da portaria:

- entradas e retiradas do dia;
- fila de encomendas por tempo de espera e prioridade;
- ocorrências abertas e alertas críticos;
- estado do banco, WhatsApp, OCR e alertas automáticos;
- movimentações recentes, com atualização automática a cada 30 segundos.

O acesso é permitido aos perfis `admin`, `supervisor` e `porteiro`. Os dados são
isolados pela associação vinculada à sessão.

## 7. Gestão de Encomendas 2.0

O painel `/encomendas-admin.html` oferece consulta completa do histórico, filtros
por situação, período e texto, além da fila priorizada pelo tempo de espera.

Regras de alteração:

- `admin` e `supervisor` podem corrigir encomendas ainda pendentes;
- somente `admin` pode cancelar ou reabrir um registro;
- correção, cancelamento e reabertura exigem motivo;
- retiradas concluídas não podem ser alteradas pelo painel;
- códigos duplicados entre encomendas pendentes são bloqueados;
- toda mudança é registrada na auditoria e na cadeia de custódia SHA-256;
- fotos, assinaturas e PINs não são enviados na listagem administrativa.

## 8. Espelhamento celular/computador

O estado completo do aplicativo fica na tabela `app_state` do Supabase:

- moradores;
- encomendas;
- terceiros vinculados;
- auditoria;
- detalhes de retirada;
- fotos e assinaturas;
- memória de remetentes;
- configurações públicas do app.

O arquivo `data/app-state.json` fica como fallback local caso o Supabase esteja temporariamente indisponível.

Celular e computador devem acessar o mesmo endereço do servidor, por exemplo:

```text
http://IP-DO-COMPUTADOR:3000
```

Assim, o que for lançado em um dispositivo é salvo no backend e carregado pelo outro.

## 9. Cópias de segurança dos acessos

O daemon de backup inclui `access-users.json`, com os registros necessários para
restaurar usuários, e `users-legacy.json`. Sessões e tokens não são incluídos no
backup. Em uma restauração, todos devem fazer um novo login.

## 10. Etiquetas sem serviço contratado

O OCR usa Tesseract.js e o leitor de códigos usa ZXing, ambos executados no
navegador com arquivos do próprio servidor. `npm ci` prepara os arquivos em
`vendor/`; `npm start` também verifica essa preparação. Não configurar chave de
OCR. Chaves de WhatsApp e banco continuam destinadas às respectivas funções.

A captura automática requer acesso **HTTPS** e permissão da câmera. Acesso por
`http://IP-DO-VPS:3000` não oferece câmera contínua nos navegadores que exigem
contexto seguro. Configure HTTPS no endereço usado pela portaria antes do teste
no celular. Consulte `TESTING.md` para atualização e validação.
