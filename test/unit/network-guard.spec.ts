import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import crossFetch from 'cross-fetch';
import dgram from 'node:dgram';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net, { type AddressInfo } from 'node:net';
import tls from 'node:tls';
import { then, when } from '@test-utils/bdd';
import { takeNetworkViolations } from '../setup/deny-network';

chai.use(chaiAsPromised);

const DENIED = 'Network access denied in unit tests';

// Runs an outbound attempt, resolves with how it failed, and consumes the violation the guard recorded for it
// (otherwise the guard's afterEach would rightly fail this test).
const attemptFailure = async (attempt: () => unknown) => {
  const error: any = await new Promise<Error>((resolve, reject) => {
    try {
      const result: any = attempt();
      if (result?.on) result.on('error', resolve);
      else Promise.resolve(result).then(() => reject(new Error('outbound call succeeded')), resolve);
    } catch (error: any) {
      resolve(error);
    }
  });
  return { message: [error.message, error.cause?.message].join(' '), violations: takeNetworkViolations() };
};

describe('Network guard', () => {
  when('a test reaches outside loopback', () => {
    const resolveFromExternalIp = (_host: string, _options: unknown, callback: Function) => callback(null, '1.1.1.1', 4);
    const attempts: Record<string, () => unknown> = {
      'net.connect': () => net.connect(443, 'example.com'),
      'tls.connect': () => tls.connect(443, 'example.com'),
      'http.get': () => http.get('http://example.com'),
      'https.get': () => https.get('https://example.com'),
      'global fetch': () => fetch('https://example.com'),
      'cross-fetch': () => crossFetch('https://example.com'),
      'raw IP': () => net.connect(443, '1.1.1.1'),
      'raw IP via options': () => new net.Socket().connect({ host: '1.1.1.1', port: 443 }),
      'localhost name with an external custom lookup': () => net.connect({ host: 'localhost', port: 443, lookup: resolveFromExternalIp as any }),
      'dns.lookup': () => dns.lookup('example.com', () => {}),
      'dns.promises.lookup': () => dns.promises.lookup('example.com'),
      'dns.resolve4': () => dns.resolve4('example.com', () => {}),
      'dns.resolveMx': () => dns.resolveMx('example.com', () => {}),
      'dns.promises.resolve4': () => dns.promises.resolve4('example.com'),
      'dns.Resolver': () => new dns.Resolver().resolve4('example.com', () => {}),
      'dns.promises.Resolver': () => new dns.promises.Resolver().resolve4('example.com'),
      'dns.reverse': () => dns.reverse('1.1.1.1', () => {}),
      'dns.lookupService': () => dns.lookupService('1.1.1.1', 443, () => {}),
      'udp createSocket': () => dgram.createSocket('udp4'),
      'udp send on a direct Socket': () => new (dgram.Socket as any)('udp4').send('x', 53, '1.1.1.1'),
    };
    for (const [name, attempt] of Object.entries(attempts)) {
      then(`${name} is denied and recorded`, async () => {
        const { message, violations } = await attemptFailure(attempt);
        expect(message).to.contain(DENIED);
        expect(violations).to.have.lengthOf(1);
      });
    }

    then('every resolver method Node exposes is denied', () => {
      const methods = [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype].flatMap((target: any) =>
        Object.getOwnPropertyNames(target).filter((name) => /^(resolve|reverse|lookupService)/.test(name) && typeof target[name] === 'function')
      );
      expect(methods.length).to.be.greaterThan(20);
      for (const target of [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype] as any[]) {
        for (const name of Object.getOwnPropertyNames(target).filter((name) => /^(resolve|reverse|lookupService)/.test(name))) {
          if (typeof target[name] === 'function') expect(() => target[name]('example.com', () => {})).to.throw(DENIED);
        }
      }
      expect(takeNetworkViolations().length).to.equal(methods.length);
    });
  });

  when('a test stays on loopback', () => {
    then('local servers are reachable through http, fetch and a localhost name', async () => {
      const server = http.createServer((_, response) => response.end('ok'));
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      try {
        expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).to.equal('ok');
        expect(await (await crossFetch(`http://localhost:${port}`)).text()).to.equal('ok');
      } finally {
        server.closeAllConnections();
        server.close();
      }
      expect(takeNetworkViolations()).to.deep.equal([]);
    });
  });
});
