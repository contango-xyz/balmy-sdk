import chai, { expect } from 'chai';
import { then, when } from '@test-utils/bdd';
import { FetchService } from '@services/fetch/fetch-service';
import chaiAsPromised from 'chai-as-promised';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

chai.use(chaiAsPromised);

describe('Fetch Service', () => {
  when('request timeouts', () => {
    then('error is clear', async () => {
      const server = http.createServer(() => {}); // accepts the request and never answers
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const service = new FetchService();
      try {
        await expect(service.fetch(url, { timeout: '1' }))
          .to.be.rejectedWith(AggregateError)
          .and.eventually.satisfy((error: AggregateError) => {
            return error.errors.some((error) => error.message.includes(`Request to ${url} timeouted`));
          });
      } finally {
        server.closeAllConnections();
        server.close();
      }
    });
  });
});
