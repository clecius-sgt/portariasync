# WhatsApp oficial no PortariaSync

O PortariaSync suporta dois provedores:

- `meta`: WhatsApp Cloud API oficial da Meta.
- `zapi`: integração legada, mantida apenas para transição.

A seleção é feita exclusivamente no servidor pelo arquivo `.env`. Tokens e identificadores não são enviados ao navegador.

## Variáveis do servidor

```env
WHATSAPP_PROVIDER=meta
META_WHATSAPP_ACCESS_TOKEN=SEU_TOKEN_PERMANENTE
META_WHATSAPP_PHONE_NUMBER_ID=SEU_PHONE_NUMBER_ID
META_WHATSAPP_WABA_ID=SEU_WABA_ID
META_GRAPH_API_VERSION=VERSAO_GRAPH_ATIVA_NO_SEU_APP
META_WHATSAPP_TEMPLATE_PACKAGE=aviso_encomenda_portaria
META_WHATSAPP_TEMPLATE_REMINDER=lembrete_encomenda_portaria
META_WHATSAPP_TEMPLATE_LANGUAGE=pt_BR
```

Não grave essas credenciais no GitHub nem no navegador.

## Templates esperados

Os nomes podem ser alterados pelo `.env`, mas a ordem dos parâmetros deve permanecer compatível com o PortariaSync.

### `aviso_encomenda_portaria`

Categoria sugerida: utilidade.

Corpo sugerido:

```text
Olá {{1}}. Uma encomenda chegou na portaria.
Código: {{2}}
Transportadora: {{3}}
Endereço: {{4}}
```

Parâmetros enviados pelo PortariaSync:

1. nome do morador
2. código da encomenda
3. transportadora/remetente
4. endereço cadastrado

### `lembrete_encomenda_portaria`

Categoria sugerida: utilidade.

Corpo sugerido:

```text
Olá {{1}}. Lembrete da portaria: a encomenda {{2}}, da transportadora {{3}}, está aguardando retirada há {{4}} dia(s).
Endereço: {{5}}
```

Parâmetros enviados pelo PortariaSync:

1. nome do morador
2. código da encomenda
3. transportadora/remetente
4. quantidade de dias aguardando retirada
5. endereço cadastrado

## Rotas do PortariaSync

- `GET /api/whatsapp/status`: informa provedor e configuração sem expor segredo.
- `POST /api/whatsapp/package`: envia aviso de nova encomenda.
- `POST /api/whatsapp/reminder`: envia lembrete de retirada.
- `POST /api/whatsapp/test`: faz um teste usando o template de aviso.
- `POST /api/whatsapp/text`: compatibilidade para texto livre. Na Meta, texto livre depende das regras de janela de atendimento e não substitui templates para avisos proativos.

## Regra de segurança da migração

Se `WHATSAPP_PROVIDER=meta`, uma falha da Meta não dispara automaticamente uma mensagem pela Z-API. Isso evita envio duplicado quando a resposta da API é incerta. Para voltar temporariamente ao provedor anterior, altere explicitamente `WHATSAPP_PROVIDER=zapi` no `.env` e reinicie o processo do PortariaSync.
