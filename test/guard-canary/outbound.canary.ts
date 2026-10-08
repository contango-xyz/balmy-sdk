import { then, when } from '@test-utils/bdd';

// Deliberately reaches the internet. scripts/check-network-guard.sh runs it expecting failure.
describe('Outbound canary', () => {
  when('a test makes an outbound request', () => {
    then('the network guard fails it', async () => {
      await fetch('https://example.com');
    });
  });
});
