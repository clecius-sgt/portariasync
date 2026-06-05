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

## 2. Rodar o sistema

No terminal, dentro da pasta do sistema:

```bash
npm start
```

Depois acesse:

```text
http://localhost:3000
```

## 3. Segurança

O `index.html` não deve conter service key, token da Z-API ou Client-Token.
Essas chaves ficam somente no backend (`server.js`) por meio do `.env`.

O backend bloqueia acesso direto a `.env`, arquivos ocultos e à pasta `data/`.
As rotas de dados, sincronização e WhatsApp exigem login com perfil permitido.

## 4. Login e usuários

Usuários criados pelo painel ficam em `data/users.json`, com senha protegida por hash PBKDF2.
Essa pasta não deve ser enviada ao GitHub.

## 5. Espelhamento celular/computador

O estado completo do aplicativo fica em `data/app-state.json`:

- moradores;
- encomendas;
- terceiros vinculados;
- auditoria;
- detalhes de retirada;
- fotos e assinaturas;
- memória de remetentes;
- configurações públicas do app.

Celular e computador devem acessar o mesmo endereço do servidor, por exemplo:

```text
http://IP-DO-COMPUTADOR:3000
```

Assim, o que for lançado em um dispositivo é salvo no backend e carregado pelo outro.

## 6. Próximo endurecimento recomendado

O próximo passo de produção é mover usuários e sessões para o banco, mantendo senhas com hash e controle de expiração de sessão.
