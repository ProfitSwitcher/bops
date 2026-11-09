/**
 * Account and billing pages the settings UI must not open while local-only is on.
 * Hosts are matched exactly or as a subdomain (www.orgo.ai, checkout.stripe.com).
 */
const ACCOUNT_HOSTS = ["orgo.ai", "stripe.com", "accounts.google.com", "orgo.cal.com"];

export function isExternalAccountUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return ACCOUNT_HOSTS.some((name) => host === name || host.endsWith(`.${name}`));
}

/** Every external account or billing URL nested in a JSON value. */
export function externalAccountUrlsIn(value: unknown, found = new Set<string>()): string[] {
  if (typeof value === "string") {
    if (isExternalAccountUrl(value)) found.add(value);
    return [...found];
  }
  if (Array.isArray(value)) {
    for (const item of value) externalAccountUrlsIn(item, found);
    return [...found];
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) externalAccountUrlsIn(item, found);
  }
  return [...found];
}

/** What Settings' plan and account calls return in local mode: no page to open. */
export function localAccountPayload(name: string) {
  return {
    local: true,
    user: { id: "local", name: name.trim() || "Local" },
    orgo: null,
    bops: null,
    billing: null,
    links: {},
  };
}
