# Planejamento Editorial • Ascom Cohab Minas

Sistema de planejamento editorial e gestão de pautas da **Assessoria de Comunicação Social da Cohab Minas**, com login, papéis de acesso e banco de dados no **Supabase**.

![favicon](apple-touch-icon.png)

---

## ✨ O que há nesta versão (2.0)

**Segurança**
- Login por e-mail e senha (cadastro público **desligado**: só o administrador cria contas)
- Três papéis: **Administrador** (tudo + usuários), **Editor** (cria e edita) e **Leitor** (só visualiza)
- **Verificação em duas etapas (2FA/TOTP)**, obrigatória para usar poderes de administrador
- Regras de acesso aplicadas **no banco** (Row Level Security). Mesmo quem alterar o JavaScript no navegador não consegue burlar as permissões
- **Log de auditoria gerado pelo servidor**, imutável (ninguém edita nem apaga)
- Senhas fortes (12+ caracteres, maiúscula, minúscula, número e símbolo)
- Bloqueio progressivo após 5 tentativas de login erradas
- Logout automático por inatividade (30 min, com aviso)
- Sessão encerra ao fechar a aba (a menos que marque "Manter conectado")
- Usuário desativado perde o acesso na hora
- Content Security Policy, proteção contra clickjacking e **nenhuma biblioteca carregada de CDN** (tudo hospedado no próprio projeto)
- Exportação Excel protegida contra injeção de fórmulas
- A chave secreta (`service_role`) fica só numa Edge Function no servidor

**Experiência de uso**
- Tela de login institucional, recuperação de senha e convite por e-mail
- Sincronização **ao vivo**: o que um colega altera aparece na hora para todos
- Calendário com botão **Hoje**, legenda de cores, feriados móveis (Carnaval, Sexta-feira Santa, Corpus Christi) e resumo do mês
- **Visão agenda automática no celular**
- Busca sem acento e aviso de resultados em outros meses
- Prioridades com filtro por status e destaque de pautas atrasadas
- Realizados agrupados por mês; log agrupado por dia, com ícones
- Modal da pauta mostra quem criou e quem editou por último
- Atalhos de teclado (`N` nova pauta, `/` busca, `T` hoje, `←` `→` meses, `1`–`6` abas, `Ctrl+Enter` salvar)
- Importação automática das pautas salvas no navegador pela versão antiga
- Relatório com indicador de pautas atrasadas e distribuição por responsável
- Favicon com o símbolo hexagonal da Cohab (adapta ao modo escuro)

---

## 📁 Estrutura

```
├── index.html                  → aplicação
├── favicon.svg / .ico / .png   → ícones com o hexágono Cohab
├── manifest.webmanifest
├── _headers                    → cabeçalhos de segurança (Netlify / Cloudflare Pages)
├── assets/
│   ├── js/config.js            → ⚠️ SUAS CHAVES DO SUPABASE (editar)
│   ├── js/app.js               → lógica do sistema
│   ├── css/app.css             → estilo compilado (Tailwind)
│   ├── fonts/                  → Inter
│   └── vendor/                 → supabase-js e Font Awesome (locais)
├── supabase/
│   ├── schema.sql              → banco, regras de segurança e auditoria
│   └── functions/admin-users/  → Edge Function de gestão de usuários
├── src/input.css + tailwind.config.js + package.json → só para recompilar o CSS
```

---

## 🚀 Passo a passo de instalação

### 1. Criar o projeto no Supabase
1. Acesse [supabase.com](https://supabase.com) → **New project**.
2. Região recomendada: **South America (São Paulo)**.
3. Guarde a senha do banco num gerenciador de senhas.

### 2. Criar as tabelas e regras de segurança
1. No painel do projeto: **SQL Editor → New query**.
2. Abra `supabase/schema.sql`, copie **todo** o conteúdo, cole e clique em **Run**.
3. Deve aparecer *Success*. (Pode rodar de novo sem problema.)

### 3. Configurar a autenticação (importante!)
Em **Authentication**:

| Onde | O que fazer |
|---|---|
| **Sign In / Providers → Email** | Desative **"Allow new users to sign up"** ← essencial; mantenha **"Confirm email"** ativo |
| **Sign In / Providers → Email → Password** | Tamanho mínimo **12** e exigir *lowercase, uppercase, digits and symbols* |
| **Attack Protection** | Ative **Leaked password protection** (se o plano permitir) e, se quiser, **CAPTCHA** |
| **Multi-Factor** | Confirme que **TOTP (App Authenticator)** está habilitado |
| **URL Configuration** | **Site URL** = endereço onde o sistema vai ficar (ex.: `https://SEU-USUARIO.github.io/NOME-DO-REPO/`). Em **Redirect URLs** adicione esse mesmo endereço e `http://localhost:5500/**` para testes |
| **SMTP Settings** (recomendado) | Configure um e-mail próprio. O e-mail padrão do Supabase envia poucas mensagens por hora; sem SMTP, prefira criar usuários com **senha temporária** |

### 4. Criar o primeiro administrador
1. **Authentication → Users → Add user → Create new user**: informe seu e-mail e uma senha forte, marque **Auto Confirm User**.
2. No **SQL Editor**, rode (trocando o e-mail e o nome):
   ```sql
   update public.profiles set role = 'admin', nome = 'Davi Caetano'
   where email = 'seu.email@cohab.mg.gov.br';
   ```
3. Depois de entrar no sistema, vá em **Minha conta → Ativar 2FA** e escaneie o QR Code com Google Authenticator, Microsoft Authenticator ou Authy. Sem 2FA o administrador funciona como Editor.

> 💡 Cadastre **dois administradores** com 2FA. Se um perder o celular, o outro redefine o 2FA dele pela aba **Usuários**.

### 5. Publicar a Edge Function `admin-users` (criar/desativar/excluir usuários)
**Pelo painel (mais fácil):**
1. **Edge Functions → Deploy a new function → Via Editor**.
2. Nome: `admin-users` (exatamente assim).
3. Apague o código de exemplo, cole o conteúdo de `supabase/functions/admin-users/index.ts` e clique em **Deploy**.
4. **Edge Functions → Secrets → Add new secret**:
   - Name: `ALLOWED_ORIGINS`
   - Value: a origem do site, **sem caminho**, ex.: `https://SEU-USUARIO.github.io` (para várias, separe por vírgula: `https://SEU-USUARIO.github.io,http://localhost:5500`)

**Ou pela linha de comando:**
```bash
npm i -g supabase
supabase login
supabase link --project-ref SEU_PROJECT_REF
supabase functions deploy admin-users
supabase secrets set ALLOWED_ORIGINS="https://SEU-USUARIO.github.io"
```

### 6. Colocar as chaves no sistema
1. **Project Settings → API Keys** (ou **Data API**).
2. Abra `assets/js/config.js` e preencha:
   ```js
   SUPABASE_URL: 'https://xxxxxxxx.supabase.co',
   SUPABASE_ANON_KEY: 'eyJhbGciOi...'   // chave "anon public" ou "publishable"
   ```
3. ⚠️ **Nunca** use a chave `service_role` / `secret` nesse arquivo.

### 7. Testar no computador
O sistema precisa rodar por um servidor (abrir o `index.html` com duplo clique não funciona com o login). Com o Node instalado, na pasta do projeto:
```bash
npx serve -l 5500 .
```
Acesse `http://localhost:5500`. Alternativa: extensão **Live Server** do VS Code (porta 5500).

---

## 🐙 Como anexar ao GitHub

### Opção A — pelo navegador (sem instalar nada)
1. Entre no GitHub e clique em **New repository** (ou abra o repositório da Cohab, se você tiver permissão de escrita).
   - Nome sugerido: `planejamento-editorial-cohab`
   - Para usar o GitHub Pages gratuito, o repositório precisa ser **Public**. Não há risco: o código não contém segredos; a segurança está no Supabase.
2. Descompacte o ZIP no computador.
3. No repositório: **Add file → Upload files**.
4. Abra a pasta descompactada, selecione **todo o conteúdo de dentro dela** (não a pasta em si, nem o .zip) e arraste para a página. As subpastas (`assets`, `supabase`, `src`) vão junto.
5. Escreva uma mensagem como `Versão 2.0 com login e Supabase` e clique em **Commit changes**.
6. **Settings → Pages → Build and deployment**: Source **Deploy from a branch**, Branch **main** / **/(root)** → **Save**.
7. Em 1–2 minutos o endereço aparece no topo da página de Pages. Use-o nos passos 3 (URL Configuration) e 5 (`ALLOWED_ORIGINS`) do Supabase.

### Opção B — pelo terminal (Git)
```bash
cd caminho/da/pasta-descompactada
git init
git add .
git commit -m "Versão 2.0 com login, papéis e Supabase"
git branch -M main
git remote add origin https://github.com/SEU-USUARIO/planejamento-editorial-cohab.git
git push -u origin main
```

### Sobre o repositório `cohabminas/...`
Ele pertence à conta/organização **cohabminas**. Para enviar direto para ele, peça ao dono que adicione seu usuário em **Settings → Collaborators** (ou como membro da organização). Outra opção é criar o repositório na sua conta (Opção A ou B) e depois transferi-lo em **Settings → Danger Zone → Transfer**.

### Hospedagem com segurança extra (opcional)
O GitHub Pages não permite cabeçalhos HTTP personalizados. Se publicar no **Netlify** ou **Cloudflare Pages** (ambos gratuitos e conectam ao GitHub), o arquivo `_headers` já ativa HSTS, bloqueio de iframe, CSP completa e outras proteções automaticamente.

---

## 👥 Papéis e permissões

| Ação | Leitor | Editor | Admin (com 2FA) |
|---|:-:|:-:|:-:|
| Ver calendário, prioridades, realizados, sugestões, log | ✅ | ✅ | ✅ |
| Criar/editar pautas, mudar status, reordenar | — | ✅ | ✅ |
| Criar/agendar/remover sugestões, notas no log | — | ✅ | ✅ |
| Excluir pautas | — | — | ✅ |
| Criar, desativar, excluir usuários, mudar papéis | — | — | ✅ |
| Redefinir senha/2FA de outra pessoa | — | — | ✅ |
| Alterar o próprio papel | — | — | — (bloqueado) |

---

## 🆘 Emergências

**Único administrador perdeu o celular do 2FA**
No SQL Editor do Supabase:
```sql
-- 1) libera temporariamente o admin sem 2FA
create or replace function public.mfa_required_for_admin() returns boolean language sql immutable as $$ select false $$;
-- 2) apague o fator antigo: Authentication → Users → (usuário) → remova o MFA factor
-- 3) entre, reative o 2FA em "Minha conta" e volte a exigir:
create or replace function public.mfa_required_for_admin() returns boolean language sql immutable as $$ select true $$;
```

**Suspeita de conta comprometida**
Aba **Usuários → desativar** a pessoa (encerra as sessões na hora). Depois, redefina senha e 2FA.

**Tela "Conexão com o Supabase não configurada"**
Faltou preencher `assets/js/config.js`.

**"Função admin-users indisponível"**
A Edge Function não foi publicada (passo 5) ou `ALLOWED_ORIGINS` não contém o endereço do site.

---

## 🎨 Alterar o visual (opcional, para desenvolvedores)
O CSS é pré-compilado. Se mudar classes do Tailwind no HTML/JS:
```bash
npm install
npm run build:css
```

---

Assessoria de Comunicação Social • Cohab Minas
Rod. Papa João Paulo II, 4001 – 14º andar (Prédio Gerais), Belo Horizonte – MG
