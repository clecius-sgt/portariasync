# PortariaSync em produção

## 1. Configurar chaves

Copie `.env.example` para `.env` e preencha:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`
- `ZAPI_URL`
- `ZAPI_CLIENT`

O arquivo `.env` não deve ser enviado ao GitHub.

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

## 4. Próximo endurecimento recomendado

O próximo passo de produção é mover usuários e senhas para o banco, com senhas criptografadas e sessão real de login.
