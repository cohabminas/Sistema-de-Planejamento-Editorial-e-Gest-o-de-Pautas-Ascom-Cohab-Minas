// =============================================================================
// Edge Function: admin-users  (v3)
// Planejamento Editorial • Ascom Cohab Minas
//
// Ações do próprio usuário (qualquer usuário logado):
//   trust_device      → após 2FA, registra este dispositivo como confiável (30 dias)
//   verify_device     → num novo login, libera a sessão se o dispositivo é confiável
//   set_own_password  → troca obrigatória da senha temporária
//
// Ações de administrador (papel admin + 2FA ou dispositivo confiável):
//   create, set_temp_password, set_active, delete, reset_password, reset_mfa,
//   revoke_devices
//
// A chave service_role fica SOMENTE aqui. Toda gravação tem o erro verificado.
// =============================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TRUST_DAYS = Number(Deno.env.get("TRUST_DAYS") ?? "30");
const MAX_DEVICES = 10;
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
  .split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);

const ROLES = ["admin", "editor", "leitor"] as const;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}

// ---------------------------------------------------------------- utilitários
function originAllowed(origin: string | null): boolean {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.length === 0) return true;
  return ALLOWED_ORIGINS.includes(origin.replace(/\/$/, ""));
}

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": originAllowed(origin) ? origin! : "null",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-api-version, x-region",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  };
}

function json(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
  });
}

function strongPassword(pw: string): boolean {
  return pw.length >= 12 && /[a-z]/.test(pw) && /[A-Z]/.test(pw) && /\d/.test(pw) && /[^A-Za-z0-9]/.test(pw);
}

function randomInt(max: number): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0] % max;
}

function generatePassword(): string {
  const sets = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!@#$%&*?-_+="];
  const all = sets.join("");
  const chars = sets.map((s) => s[randomInt(s.length)]);
  while (chars.length < 16) chars.push(all[randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) { const j = randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join("");
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function decodeJwt(token: string): Record<string, unknown> {
  try {
    let p = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    while (p.length % 4) p += "=";
    return JSON.parse(atob(p));
  } catch { return {}; }
}

// Navegador/sistema sem números de versão (atualizar o navegador não exige 2FA de novo)
function uaFingerprint(ua: string): string {
  return ua.toLowerCase().replace(/[\d._]+/g, "").replace(/\s+/g, " ").trim();
}

function deviceLabel(ua: string): string {
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Navegador";
  const os = /Windows/.test(ua) ? "Windows" : /iPhone|iPad/.test(ua) ? "iPhone/iPad" : /Android/.test(ua) ? "Android"
    : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "sistema desconhecido";
  return `${browser} no ${os}`;
}

function friendlyAuthError(msg: string): HttpError {
  if (/already.*registered|already exists/i.test(msg)) return new HttpError(400, "Já existe um usuário com este e-mail.");
  if (/rate limit/i.test(msg)) {
    return new HttpError(429, "O limite de envio de e-mails foi atingido. Use \"Senha temporária\" ou configure um SMTP próprio (veja o README).", "email_unavailable");
  }
  if (/not authorized|email_address_not_authorized/i.test(msg)) {
    return new HttpError(400, "O servidor de e-mail padrão do Supabase só envia para a equipe do projeto. Use \"Senha temporária\" ou configure um SMTP próprio.", "email_unavailable");
  }
  if (/password/i.test(msg) && /weak|short|characters/i.test(msg)) return new HttpError(400, "Senha fraca para a política do Supabase.");
  return new HttpError(400, "Não foi possível concluir a operação.");
}

// deno-lint-ignore no-explicit-any
function must(res: { data: any; error: { message: string } | null }, context: string): any {
  if (res.error) {
    console.error(`[admin-users] ${context}:`, res.error.message);
    throw new HttpError(500, `Falha ao gravar no banco (${context}).`);
  }
  return res.data;
}

// ---------------------------------------------------------------- handler
Deno.serve(async (req) => {
  const origin = req.headers.get("Origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(origin) });
  if (req.method !== "POST") return json({ error: "Método não permitido." }, 405, origin);
  if (!originAllowed(origin)) return json({ error: "Origem não autorizada." }, 403, origin);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "Não autenticado." }, 401, origin);
  const jwt = authHeader.slice(7);
  const claims = decodeJwt(jwt);

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) return json({ error: "Sessão inválida ou expirada." }, 401, origin);
  const caller = userData.user;

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Requisição inválida." }, 400, origin); }
  const action = String(body.action ?? "");

  const ua = req.headers.get("User-Agent") ?? "";
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || null;

  try {
    const callerProfile = must(
      await admin.from("profiles").select("nome, ativo, role").eq("id", caller.id).maybeSingle(), "perfil do chamador");
    if (!callerProfile?.ativo) throw new HttpError(403, "Acesso desativado.");
    const callerName = callerProfile.nome || caller.email || "Usuário";

    const log = async (acao: string, detalhe: string) => {
      const r = await admin.from("logs").insert({ acao, detalhe: detalhe.slice(0, 1000), user_id: caller.id, user_nome: callerName });
      if (r.error) console.error("[admin-users] log:", r.error.message);
    };

    // =========================================================== AÇÕES PRÓPRIAS
    if (action === "trust_device") {
      if (claims.aal !== "aal2") throw new HttpError(403, "Confirme o código de 2 etapas antes de confiar no dispositivo.");
      const token = randomToken();
      const expires = new Date(Date.now() + TRUST_DAYS * 86400000).toISOString();
      const label = deviceLabel(ua);

      // limita a quantidade de dispositivos por pessoa (remove os mais antigos)
      const existing = must(await admin.from("trusted_devices").select("id").eq("user_id", caller.id)
        .order("last_used_at", { ascending: false }), "listar dispositivos") ?? [];
      const excess = existing.slice(MAX_DEVICES - 1).map((d: { id: string }) => d.id);
      if (excess.length) must(await admin.from("trusted_devices").delete().in("id", excess), "limpar dispositivos");

      const device = must(await admin.from("trusted_devices").insert({
        user_id: caller.id, token_hash: await sha256(token), ua_hash: await sha256(uaFingerprint(ua)),
        label, last_ip: ip, expires_at: expires,
      }).select("id, expires_at").single(), "registrar dispositivo");
      await log("ACESSO", `Dispositivo confiável registrado (${label}) por ${TRUST_DAYS} dias.`);
      return json({ ok: true, token, device_id: device.id, expires_at: device.expires_at, label }, 200, origin);
    }

    if (action === "verify_device") {
      const token = typeof body.token === "string" ? body.token : "";
      const sessionId = typeof claims.session_id === "string" ? claims.session_id : "";
      if (!token || token.length > 100 || !UUID_RE.test(sessionId)) return json({ ok: false, reason: "invalid" }, 200, origin);

      const device = must(await admin.from("trusted_devices")
        .select("id, user_id, ua_hash, expires_at, label")
        .eq("token_hash", await sha256(token)).maybeSingle(), "consultar dispositivo");

      const risk =
        !device ? "unknown_device"
        : device.user_id !== caller.id ? "unknown_device"
        : new Date(device.expires_at) < new Date() ? "expired"
        : device.ua_hash !== await sha256(uaFingerprint(ua)) ? "browser_changed"
        : null;

      if (risk) {
        if (device && device.user_id === caller.id) {
          must(await admin.from("trusted_devices").delete().eq("id", device.id), "revogar dispositivo");
          await log("ACESSO", `Dispositivo confiável recusado (${risk === "expired" ? "expirado" : "navegador diferente"}); 2FA exigido.`);
        }
        return json({ ok: false, reason: risk }, 200, origin);
      }

      // O usuário ainda precisa ter um fator 2FA verificado
      const { data: factors } = await admin.auth.admin.mfa.listFactors({ userId: caller.id });
      if (!(factors?.factors ?? []).some((f: { status: string }) => f.status === "verified")) {
        must(await admin.from("trusted_devices").delete().eq("id", device!.id), "revogar dispositivo");
        return json({ ok: false, reason: "no_factor" }, 200, origin);
      }

      must(await admin.from("trusted_sessions").upsert({
        session_id: sessionId, user_id: caller.id, device_id: device!.id, expires_at: device!.expires_at,
      }), "liberar sessão");
      must(await admin.from("trusted_devices").update({ last_used_at: new Date().toISOString(), last_ip: ip })
        .eq("id", device!.id), "atualizar dispositivo");
      return json({ ok: true, label: device!.label, expires_at: device!.expires_at }, 200, origin);
    }

    if (action === "set_own_password") {
      const password = typeof body.password === "string" ? body.password : "";
      if (caller.app_metadata?.must_change_password !== true) throw new HttpError(400, "Use a opção normal de troca de senha.");
      if (!strongPassword(password)) throw new HttpError(400, "Senha fraca: mínimo 12 caracteres com maiúscula, minúscula, número e símbolo.");
      const { error } = await admin.auth.admin.updateUserById(caller.id, {
        password, app_metadata: { ...caller.app_metadata, must_change_password: false },
      });
      if (error) throw friendlyAuthError(error.message);
      await log("USUÁRIO", "Senha temporária substituída pela senha definitiva.");
      return json({ ok: true }, 200, origin);
    }

    // ======================================================= AÇÕES DE ADMIN
    const { data: isAdmin, error: adminErr } = await userClient.rpc("is_admin");
    if (adminErr || isAdmin !== true) {
      throw new HttpError(403, "Acesso negado. Requer administrador com verificação em duas etapas.");
    }

    const redirectTo = (() => {
      try {
        const u = new URL(String(body.redirectTo ?? ""));
        return originAllowed(u.origin) ? u.origin + u.pathname : undefined;
      } catch { return undefined; }
    })();

    const targetId = String(body.user_id ?? "");
    const needTarget = () => {
      if (!UUID_RE.test(targetId)) throw new HttpError(400, "Usuário inválido.");
      if (targetId === caller.id) throw new HttpError(400, "Use \"Minha conta\" para alterar a sua própria conta.");
    };
    const targetProfile = async () =>
      must(await admin.from("profiles").select("nome, email").eq("id", targetId).maybeSingle(), "perfil do alvo");

    switch (action) {
      case "create": {
        const email = String(body.email ?? "").trim().toLowerCase();
        const nome = String(body.nome ?? "").trim().slice(0, 120);
        const role = String(body.role ?? "leitor");
        // "temp" (senha gerada no servidor), "invite" (e-mail) ou "given" (versão antiga do site, senha informada)
        const mode = body.mode === "invite" || body.mode === "temp" ? body.mode
          : (typeof body.password === "string" && body.password ? "given" : "invite");
        if (!EMAIL_RE.test(email)) throw new HttpError(400, "E-mail inválido.");
        if (!nome) throw new HttpError(400, "Informe o nome.");
        if (!ROLES.includes(role as typeof ROLES[number])) throw new HttpError(400, "Papel inválido.");

        let newId: string | undefined;
        let tempPassword: string | undefined;
        if (mode === "temp" || mode === "given") {
          const given = String(body.password ?? "");
          if (mode === "given" && !strongPassword(given)) throw new HttpError(400, "Senha fraca: mínimo 12 caracteres com maiúscula, minúscula, número e símbolo.");
          tempPassword = mode === "temp" ? generatePassword() : undefined;
          const { data, error } = await admin.auth.admin.createUser({
            email, password: tempPassword ?? given, email_confirm: true,
            user_metadata: { nome }, app_metadata: { role, must_change_password: mode === "temp" },
          });
          if (error) throw friendlyAuthError(error.message);
          newId = data.user?.id;
        } else {
          const { data, error } = await admin.auth.admin.inviteUserByEmail(email, { data: { nome }, redirectTo });
          if (error) throw friendlyAuthError(error.message);
          newId = data.user?.id;
          if (newId) {
            const { error: e2 } = await admin.auth.admin.updateUserById(newId, { app_metadata: { role } });
            if (e2) console.error("[admin-users] app_metadata:", e2.message);
          }
        }
        if (!newId) throw new HttpError(500, "Usuário não criado.");

        // Garante papel, nome e acesso ativo (independe do gatilho)
        must(await admin.from("profiles").upsert({ id: newId, nome, email, role, ativo: true }), "perfil do novo usuário");
        await log("USUÁRIO", `Usuário "${nome}" (${email}) criado como ${role}${mode === "invite" ? " por convite" : " com senha temporária"}.`);
        return json({ ok: true, id: newId, temp_password: tempPassword }, 200, origin);
      }

      case "set_temp_password": {
        needTarget();
        const prof = await targetProfile();
        if (!prof) throw new HttpError(404, "Usuário não encontrado.");
        const { data: u, error: ge } = await admin.auth.admin.getUserById(targetId);
        if (ge || !u?.user) throw new HttpError(404, "Usuário não encontrado.");
        const tempPassword = generatePassword();
        const { error } = await admin.auth.admin.updateUserById(targetId, {
          password: tempPassword, app_metadata: { ...u.user.app_metadata, must_change_password: true },
        });
        if (error) throw friendlyAuthError(error.message);
        await log("USUÁRIO", `Senha temporária gerada para "${prof.nome}".`);
        return json({ ok: true, temp_password: tempPassword }, 200, origin);
      }

      case "set_active": {
        needTarget();
        const ativo = body.ativo === true;
        const { error } = await admin.auth.admin.updateUserById(targetId, { ban_duration: ativo ? "none" : "876000h" });
        if (error) throw friendlyAuthError(error.message);
        const prof = must(await admin.from("profiles").update({ ativo }).eq("id", targetId).select("nome").maybeSingle(), "status do usuário");
        if (!ativo) must(await admin.from("trusted_devices").delete().eq("user_id", targetId), "revogar dispositivos");
        await log("USUÁRIO", `Acesso de "${prof?.nome ?? targetId}" ${ativo ? "reativado" : "desativado"}.`);
        return json({ ok: true }, 200, origin);
      }

      case "delete": {
        needTarget();
        const prof = await targetProfile();
        const { error } = await admin.auth.admin.deleteUser(targetId);
        if (error) throw friendlyAuthError(error.message);
        await log("USUÁRIO", `Usuário "${prof?.nome ?? targetId}" (${prof?.email ?? "-"}) excluído.`);
        return json({ ok: true }, 200, origin);
      }

      case "reset_password": {
        needTarget();
        const prof = await targetProfile();
        if (!prof?.email) throw new HttpError(400, "Usuário sem e-mail.");
        const { error } = await admin.auth.resetPasswordForEmail(prof.email, { redirectTo });
        if (error) throw friendlyAuthError(error.message);
        await log("USUÁRIO", `Link de redefinição de senha enviado para "${prof.nome}".`);
        return json({ ok: true }, 200, origin);
      }

      case "reset_mfa": {
        needTarget();
        const { data: factors, error } = await admin.auth.admin.mfa.listFactors({ userId: targetId });
        if (error) throw friendlyAuthError(error.message);
        for (const f of factors?.factors ?? []) await admin.auth.admin.mfa.deleteFactor({ userId: targetId, id: f.id });
        must(await admin.from("trusted_devices").delete().eq("user_id", targetId), "revogar dispositivos");
        const prof = await targetProfile();
        await log("USUÁRIO", `Verificação em duas etapas de "${prof?.nome ?? targetId}" redefinida.`);
        return json({ ok: true }, 200, origin);
      }

      case "revoke_devices": {
        needTarget();
        must(await admin.from("trusted_devices").delete().eq("user_id", targetId), "revogar dispositivos");
        const prof = await targetProfile();
        await log("USUÁRIO", `Dispositivos confiáveis de "${prof?.nome ?? targetId}" revogados.`);
        return json({ ok: true }, 200, origin);
      }

      default:
        throw new HttpError(400, "Ação desconhecida.");
    }
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status, origin);
    console.error(`[admin-users] ${action}:`, e instanceof Error ? e.message : String(e));
    return json({ error: "Não foi possível concluir a operação." }, 500, origin);
  }
});
