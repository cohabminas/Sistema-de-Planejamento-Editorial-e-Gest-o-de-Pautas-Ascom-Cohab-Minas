// =============================================================================
// Edge Function: admin-users
// Gestão de usuários do Planejamento Editorial • Ascom Cohab Minas
//
// A chave service_role fica SOMENTE aqui (variável de ambiente do Supabase),
// nunca no navegador. Toda chamada é validada:
//   1. JWT válido do usuário que chamou
//   2. public.is_admin() = true  (papel admin + MFA aal2 + perfil ativo)
//   3. Origem permitida (ALLOWED_ORIGINS)
//
// Deploy:  supabase functions deploy admin-users
// Secrets: supabase secrets set ALLOWED_ORIGINS="https://SEU-USUARIO.github.io"
// =============================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
  .split(",")
  .map((s) => s.trim().replace(/\/$/, ""))
  .filter(Boolean);

const ROLES = ["admin", "editor", "leitor"] as const;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function originAllowed(origin: string | null): boolean {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.length === 0) return true; // configure ALLOWED_ORIGINS em produção!
  return ALLOWED_ORIGINS.includes(origin.replace(/\/$/, ""));
}

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": originAllowed(origin) ? origin! : "null",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-api-version, x-region",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
    "X-Content-Type-Options": "nosniff",
  };
}

function json(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
  });
}

function strongPassword(pw: string): boolean {
  return pw.length >= 12 && /[a-z]/.test(pw) && /[A-Z]/.test(pw) && /\d/.test(pw) && /[^A-Za-z0-9]/.test(pw);
}

function safeRedirect(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    const u = new URL(url);
    return originAllowed(u.origin) ? u.origin + u.pathname : undefined;
  } catch {
    return undefined;
  }
}

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin");

  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(origin) });
  if (req.method !== "POST") return json({ error: "Método não permitido." }, 405, origin);
  if (!originAllowed(origin)) return json({ error: "Origem não autorizada." }, 403, origin);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "Não autenticado." }, 401, origin);

  // Cliente com o JWT do chamador (respeita RLS e carrega o nível aal)
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) return json({ error: "Sessão inválida ou expirada." }, 401, origin);
  const caller = userData.user;

  const { data: isAdmin, error: adminErr } = await userClient.rpc("is_admin");
  if (adminErr || isAdmin !== true) {
    return json({ error: "Acesso negado. Requer administrador com verificação em duas etapas ativa." }, 403, origin);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: callerProfile } = await admin.from("profiles").select("nome").eq("id", caller.id).single();
  const callerName = callerProfile?.nome ?? caller.email ?? "Administrador";

  const log = (detalhe: string) =>
    admin.from("logs").insert({ acao: "USUÁRIO", detalhe: detalhe.slice(0, 1000), user_id: caller.id, user_nome: callerName });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Requisição inválida." }, 400, origin);
  }

  const action = String(body.action ?? "");
  const redirectTo = safeRedirect(body.redirectTo);

  try {
    switch (action) {
      // ---------------------------------------------------------------- CREATE
      case "create": {
        const email = String(body.email ?? "").trim().toLowerCase();
        const nome = String(body.nome ?? "").trim().slice(0, 120);
        const role = String(body.role ?? "leitor");
        const password = typeof body.password === "string" ? body.password : "";

        if (!EMAIL_RE.test(email)) return json({ error: "E-mail inválido." }, 400, origin);
        if (!nome) return json({ error: "Informe o nome." }, 400, origin);
        if (!ROLES.includes(role as typeof ROLES[number])) return json({ error: "Papel inválido." }, 400, origin);
        if (password && !strongPassword(password)) {
          return json({ error: "Senha fraca: mínimo 12 caracteres com maiúscula, minúscula, número e símbolo." }, 400, origin);
        }

        let newId: string | undefined;
        if (password) {
          const { data, error } = await admin.auth.admin.createUser({
            email, password, email_confirm: true, user_metadata: { nome },
          });
          if (error) throw error;
          newId = data.user?.id;
        } else {
          const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
            data: { nome }, redirectTo,
          });
          if (error) throw error;
          newId = data.user?.id;
        }
        if (!newId) throw new Error("Usuário não criado.");

        await admin.from("profiles").upsert({ id: newId, nome, email, role, ativo: true });
        await log(`Usuário "${nome}" (${email}) criado como ${role}${password ? " com senha temporária" : " por convite"}.`);
        return json({ ok: true, id: newId }, 200, origin);
      }

      // ------------------------------------------------------------ SET ACTIVE
      case "set_active": {
        const userId = String(body.user_id ?? "");
        const ativo = body.ativo === true;
        if (!UUID_RE.test(userId)) return json({ error: "Usuário inválido." }, 400, origin);
        if (userId === caller.id) return json({ error: "Você não pode desativar a si mesmo." }, 400, origin);

        const { error } = await admin.auth.admin.updateUserById(userId, {
          ban_duration: ativo ? "none" : "876000h",
        });
        if (error) throw error;
        const { data: prof } = await admin.from("profiles").update({ ativo }).eq("id", userId).select("nome").single();
        if (!ativo) await admin.auth.admin.signOut(userId).catch(() => {});
        await log(`Acesso de "${prof?.nome ?? userId}" ${ativo ? "reativado" : "desativado"}.`);
        return json({ ok: true }, 200, origin);
      }

      // ---------------------------------------------------------------- DELETE
      case "delete": {
        const userId = String(body.user_id ?? "");
        if (!UUID_RE.test(userId)) return json({ error: "Usuário inválido." }, 400, origin);
        if (userId === caller.id) return json({ error: "Você não pode excluir a si mesmo." }, 400, origin);

        const { data: prof } = await admin.from("profiles").select("nome, email").eq("id", userId).single();
        const { error } = await admin.auth.admin.deleteUser(userId);
        if (error) throw error;
        await log(`Usuário "${prof?.nome ?? userId}" (${prof?.email ?? "-"}) excluído.`);
        return json({ ok: true }, 200, origin);
      }

      // -------------------------------------------------------- RESET PASSWORD
      case "reset_password": {
        const userId = String(body.user_id ?? "");
        if (!UUID_RE.test(userId)) return json({ error: "Usuário inválido." }, 400, origin);
        const { data: prof } = await admin.from("profiles").select("nome, email").eq("id", userId).single();
        if (!prof?.email) return json({ error: "Usuário sem e-mail." }, 400, origin);
        const { error } = await admin.auth.resetPasswordForEmail(prof.email, { redirectTo });
        if (error) throw error;
        await log(`Link de redefinição de senha enviado para "${prof.nome}".`);
        return json({ ok: true }, 200, origin);
      }

      // ------------------------------------------------------------ RESET MFA
      case "reset_mfa": {
        const userId = String(body.user_id ?? "");
        if (!UUID_RE.test(userId)) return json({ error: "Usuário inválido." }, 400, origin);
        if (userId === caller.id) return json({ error: "Use 'Minha conta' para gerenciar seu próprio 2FA." }, 400, origin);
        const { data: factors, error } = await admin.auth.admin.mfa.listFactors({ userId });
        if (error) throw error;
        for (const f of factors?.factors ?? []) {
          await admin.auth.admin.mfa.deleteFactor({ userId, id: f.id });
        }
        const { data: prof } = await admin.from("profiles").select("nome").eq("id", userId).single();
        await log(`Verificação em duas etapas de "${prof?.nome ?? userId}" redefinida.`);
        return json({ ok: true }, 200, origin);
      }

      default:
        return json({ error: "Ação desconhecida." }, 400, origin);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const friendly = /already.*registered|already exists/i.test(msg)
      ? "Já existe um usuário com este e-mail."
      : /rate limit/i.test(msg)
        ? "Limite de envio de e-mails atingido. Tente mais tarde ou use senha temporária."
        : "Não foi possível concluir a operação.";
    console.error(`[admin-users] ${action}:`, msg);
    return json({ error: friendly }, 400, origin);
  }
});
