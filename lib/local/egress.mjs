/**
 * Fail-closed egress guard for local-only mode.
 * Allows loopback, RFC1918, link-local (except cloud metadata), Tailscale CGNAT
 * (100.64.0.0/10), and IPv6 unique-local / link-local. Refuses every other address
 * before a socket is opened. Public host names are refused without a DNS lookup.
 */
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

export class LocalOnlyError extends Error {
  constructor(host) {
    super(
      `Local-only mode refused a connection to ${host}. Only loopback, LAN, link-local, and Tailscale addresses are allowed, and this fork will not fall back to a cloud service.`,
    );
    this.name = "LocalOnlyError";
    this.host = String(host);
  }
}

const refused = [];

/** Addresses the guard has refused since it was installed (newest last). */
export function refusedConnections() {
  return refused.slice();
}

export function isLocalAddress(address) {
  const a = String(address).replace(/^\[(.*)\]$/, "$1").replace(/%.*$/, "");
  const kind = net.isIP(a);
  if (kind === 4) return v4(a);
  if (kind === 6) return v6(a);
  return false;
}

function v4(a) {
  const p = a.split(".").map((n) => Number(n));
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a0, a1] = p;
  if (a0 === 127) return true;
  if (a0 === 10) return true;
  if (a0 === 172 && a1 >= 16 && a1 <= 31) return true;
  if (a0 === 192 && a1 === 168) return true;
  // Tailscale and other CGNAT. Not the public internet.
  if (a0 === 100 && a1 >= 64 && a1 <= 127) return true;
  // Link-local, but not the cloud metadata address.
  if (a0 === 169 && a1 === 254) return !(p[2] === 169 && p[3] === 254);
  return false;
}

function v6(a) {
  const s = a.toLowerCase();
  if (s === "::1") return true;
  if (s.startsWith("fe80:")) return true;
  if (s.startsWith("fc") || s.startsWith("fd")) return true;
  // IPv4-mapped.
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return v4(mapped[1]);
  return false;
}

/** A name we may resolve. Public names are refused here, before DNS. */
export function nameAllowed(hostname) {
  const host = String(hostname).replace(/\.$/, "").toLowerCase();
  if (!host) return false;
  if (net.isIP(host)) return isLocalAddress(host);
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".lan") || host.endsWith(".internal") || host.endsWith(".home.arpa")) return true;
  if (host.endsWith(".ts.net")) return true;
  // A single label is a LAN search name (studio3, geforce5). The resolved IP is checked again.
  if (!host.includes(".")) return true;
  return false;
}

export function assertLocalHost(hostname) {
  if (!nameAllowed(hostname)) {
    refused.push(String(hostname));
    throw new LocalOnlyError(hostname);
  }
  if (net.isIP(hostname) && !isLocalAddress(hostname)) {
    refused.push(String(hostname));
    throw new LocalOnlyError(hostname);
  }
}

let installed = false;
let nativeFetch = globalThis.fetch?.bind(globalThis);

export function egressInstalled() {
  return installed;
}

export function installEgressGuard() {
  if (installed) return;
  installed = true;
  nativeFetch = globalThis.fetch?.bind(globalThis);
  patchSocket();
  patchLookup();
  patchRequest(http);
  patchRequest(https);
  if (typeof globalThis.fetch === "function") {
    const orig = nativeFetch;
    globalThis.fetch = async (input, init) => {
      const url = requestUrl(input);
      if (url) assertHttp(url);
      return orig(input, init);
    };
  }
}

function requestUrl(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input.url === "string") return input.url;
  return "";
}

function assertHttp(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return;
  assertLocalHost(u.hostname);
}

function patchRequest(mod) {
  const orig = mod.request;
  mod.request = function (url, options, cb) {
    const host = hostOf(url, options);
    if (host) assertLocalHost(host);
    return orig.call(this, url, options, cb);
  };
}

function hostOf(url, options) {
  if (typeof url === "string") {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  }
  if (url instanceof URL) return url.hostname;
  const opts = typeof url === "object" && url ? url : options;
  if (!opts || typeof opts !== "object") return "";
  return bareHost(opts.hostname || opts.host || "");
}

function bareHost(host) {
  const h = String(host || "").trim();
  if (!h) return "";
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end > 0 ? h.slice(1, end) : h;
  }
  if (net.isIP(h)) return h;
  const colon = h.lastIndexOf(":");
  if (colon > 0 && /^\d+$/.test(h.slice(colon + 1))) return h.slice(0, colon);
  return h;
}

function patchSocket() {
  const orig = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (options, ...rest) {
    const spec = specOf(options, rest);
    if (spec.path && !spec.host) return orig.call(this, options, ...rest);
    if (spec.host) {
      if (!nameAllowed(spec.host) || (net.isIP(spec.host) && !isLocalAddress(spec.host))) {
        refused.push(spec.host);
        const err = new LocalOnlyError(spec.host);
        if (typeof spec.cb === "function") queueMicrotask(() => spec.cb(err));
        this.destroy(err);
        return this;
      }
    }
    return orig.call(this, options, ...rest);
  };
}

function specOf(options, rest) {
  // Node 22 calls socket.connect([{ port, host }, callback]).
  if (Array.isArray(options)) return specOf(options[0], options.slice(1).concat(rest));
  if (typeof options === "string" && !/^\d+$/.test(options) && !net.isIP(options)) return { path: options };
  if (typeof options === "object" && options) {
    return { host: bareHost(options.host || options.hostname || ""), path: options.path, cb: rest[0] };
  }
  const host = typeof rest[0] === "string" ? rest[0] : undefined;
  const cb = rest.find((x) => typeof x === "function");
  return { host: host ? bareHost(host) : undefined, cb };
}

function patchLookup() {
  const lookup = dns.lookup;
  dns.lookup = function (hostname, options, cb) {
    const callback = typeof options === "function" ? options : cb;
    const opts = typeof options === "function" ? {} : options;
    try {
      assertLocalHost(String(hostname));
    } catch (e) {
      if (typeof callback === "function") callback(e);
      return;
    }
    return lookup.call(dns, hostname, opts, callback);
  };
  const promises = dns.promises.lookup;
  dns.promises.lookup = async function (hostname, options) {
    assertLocalHost(String(hostname));
    return promises.call(dns.promises, hostname, options);
  };
}
