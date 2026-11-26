/* =============================================================================
 * CONFIGURAÇÃO DO SUPABASE
 * -----------------------------------------------------------------------------
 * Supabase → Project Settings → API (ou "Data API" / "API Keys"):
 *   • SUPABASE_URL      → "Project URL"
 *   • SUPABASE_ANON_KEY → chave "anon public" (ou "publishable", começa com sb_publishable_)
 *
 * ⚠️  Esta chave é PÚBLICA por design: a proteção real está nas regras RLS do
 *     banco (supabase/schema.sql). NUNCA coloque aqui a chave "service_role"
 *     ou "secret" — ela dá acesso total e deve ficar só na Edge Function.
 * ========================================================================== */
window.COHAB_CONFIG = Object.freeze({
  SUPABASE_URL: 'https://vavexyomolwoljlsobeb.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_pfS9bel6hs2iB7e24XvAKA_TPQo2uow',

  // Desconecta automaticamente após X minutos sem atividade
  INACTIVITY_MINUTES: 30,

  // Nome da Edge Function de gestão de usuários
  ADMIN_FUNCTION: 'admin-users',

  // Deve refletir public.mfa_required_for_admin() no banco
  ADMIN_REQUIRES_MFA: true
});
