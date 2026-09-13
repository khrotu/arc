export function redactSecrets(text: string, secrets: (string | undefined)[] = []): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 6) redacted = redacted.split(secret).join("[REDACTED]");
  }
  redacted = redacted
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|sk-proj|sk-ant|ghp|github_pat)-?[_A-Za-z0-9-]{16,}\b/g, "[REDACTED]")
    .replace(/\bxox[bpas]-[A-Za-z0-9-]{8,}\b/g, "[REDACTED]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]")
    .replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{0,200}?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/\b(?:or|zai|glm|kimi|moonshot)-[A-Za-z0-9]{16,}\b/g, "[REDACTED]")
    .replace(/\bapi[_-]?key\s*[:=]\s*['"]?[A-Za-z0-9._~+/=-]{8,}['"]?/gi, "api_key=[REDACTED]");
  return redacted.slice(0, 4096);
}