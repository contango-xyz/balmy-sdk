import dgram from 'node:dgram';
import dns from 'node:dns';
import net from 'node:net';

// Unit tests must never leave the machine: only loopback TCP (local fixture servers) and unix sockets are allowed.
// Every TCP client in Node (net, tls, http, https, http2, fetch/undici, cross-fetch, ws) goes through Socket.prototype.connect.
// Each attempt throws AND is recorded, so a test that catches the error still fails in afterEach.
const LOOPBACK = /^(localhost|127(\.\d+){3}|::1)$/;
const violations: string[] = [];
const denied = (what: string) => {
  violations.push(what);
  return new Error(`Network access denied in unit tests: ${what}`);
};

/** For the guard's own self-test: returns and clears the attempts recorded so far. */
export const takeNetworkViolations = () => violations.splice(0);

// net.connect hands Socket.connect a normalized [options, callback] array; direct callers pass options, a path or (port, host).
const connectTarget = ([first, second]: any[]): { host: string; lookup?: unknown } | { path: string } => {
  const options = Array.isArray(first) ? first[0] : first;
  if (typeof options === 'object' && options !== null) {
    return options.path ? { path: options.path } : { host: options.host ?? 'localhost', lookup: options.lookup };
  }
  if (typeof options === 'string') return { path: options };
  return { host: typeof second === 'string' ? second : 'localhost' };
};

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: any[]) {
  const target = connectTarget(args);
  if ('host' in target && (!LOOPBACK.test(target.host) || target.lookup)) throw denied(`connect ${target.host}`);
  return connect.apply(this, args as any);
} as typeof net.Socket.prototype.connect;

// DNS: lookup is allowed for loopback names only. Every resolve*/reverse/lookupService method is denied, on the module
// functions, on promises, and on both Resolver classes (they query nameservers directly, outside the socket patch).
const RESOLVER_METHOD = /^(resolve|reverse|lookupService)/;
const denyMethods = (target: any, label: string) => {
  for (const name of Object.getOwnPropertyNames(target)) {
    if (RESOLVER_METHOD.test(name) && typeof target[name] === 'function') {
      target[name] = () => {
        throw denied(`${label}.${name}`);
      };
    }
  }
};
denyMethods(dns, 'dns');
denyMethods(dns.promises, 'dns.promises');
denyMethods(dns.Resolver.prototype, 'dns.Resolver');
denyMethods(dns.promises.Resolver.prototype, 'dns.promises.Resolver');

const guardLookup = (lookup: any) =>
  function (this: unknown, host: string, ...rest: unknown[]) {
    if (!LOOPBACK.test(host)) throw denied(`dns.lookup ${host}`);
    return lookup.call(this, host, ...rest);
  };
dns.lookup = guardLookup(dns.lookup) as typeof dns.lookup;
dns.promises.lookup = guardLookup(dns.promises.lookup) as typeof dns.promises.lookup;

for (const method of ['send', 'connect'] as const) {
  (dgram.Socket.prototype as any)[method] = () => {
    throw denied(`udp ${method}`);
  };
}
dgram.createSocket = (() => {
  throw denied('udp createSocket');
}) as typeof dgram.createSocket;

afterEach(() => {
  const attempts = takeNetworkViolations();
  if (attempts.length) throw new Error(`Test attempted outbound network access: ${attempts.join(', ')}`);
});
