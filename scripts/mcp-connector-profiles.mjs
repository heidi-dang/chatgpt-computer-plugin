const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function normalizedRedirectUri(value) {
  const parsed = new URL(String(value).trim());
  if (parsed.hash) throw new Error("connector redirect URI must not include a fragment");
  if (parsed.protocol === "https:") return parsed.href;
  if (parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname)) return parsed.href;
  throw new Error("connector redirect URI must use HTTPS or an HTTP loopback host");
}

export function inferConnectorApplicationType(redirectUris) {
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    throw new Error("connector redirect_uris must contain at least one URI");
  }
  const urls = redirectUris.map((value) => new URL(normalizedRedirectUri(value)));
  return urls.every((url) => url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))
    ? "native"
    : "web";
}

function normalizeProfile(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`connector profile ${index + 1} must be an object`);
  }
  const redirectUris = Array.isArray(value.redirect_uris)
    ? value.redirect_uris.map(normalizedRedirectUri)
    : [];
  if (redirectUris.length === 0) {
    throw new Error(`connector profile ${index + 1} must contain redirect_uris`);
  }
  const clientName = typeof value.client_name === "string" && value.client_name.trim()
    ? value.client_name.trim()
    : `CPTR edge qualification ${index + 1}`;
  if (clientName.length > 160) throw new Error(`connector profile ${index + 1} client_name is too long`);
  const applicationType = value.application_type ?? inferConnectorApplicationType(redirectUris);
  if (applicationType !== "native" && applicationType !== "web") {
    throw new Error(`connector profile ${index + 1} application_type must be native or web`);
  }
  return {
    client_name: clientName,
    redirect_uris: [...new Set(redirectUris)],
    application_type: applicationType,
  };
}

export function parseConnectorProfiles({ profilesJson, legacyRedirectUris }) {
  if (profilesJson?.trim()) {
    let parsed;
    try {
      parsed = JSON.parse(profilesJson);
    } catch (error) {
      throw new Error(`CPTR_EDGE_DCR_CLIENTS_JSON is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("CPTR_EDGE_DCR_CLIENTS_JSON must be a non-empty JSON array");
    }
    return parsed.map(normalizeProfile);
  }

  const redirects = String(legacyRedirectUris ?? "")
    .split(/[\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (redirects.length === 0) {
    throw new Error("CPTR_EDGE_DCR_REDIRECT_URIS must contain at least one redirect URI");
  }
  return redirects.map((redirectUri, index) => normalizeProfile({ redirect_uris: [redirectUri] }, index));
}
