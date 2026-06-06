-- PortariaSync: banco definitivo para espelhamento completo do app
-- Execute este script uma vez no SQL Editor do Supabase.

create table if not exists public.app_state (
  id text primary key,
  version bigint not null default 0,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists app_state_updated_at_idx
  on public.app_state (updated_at desc);

-- Como o backend usa SUPABASE_SERVICE_KEY, ele acessa esta tabela pelo servidor.
-- Não exponha a service key no frontend nem no GitHub.

