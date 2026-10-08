import { then, when } from '@test-utils/bdd';

// Catches the guard's error and carries on, as production code with a fallback would. The test must still fail.
describe('Swallowed outbound canary', () => {
  when('a test catches the denied request', () => {
    then('the guard still fails it', async () => {
      await fetch('https://example.com').catch(() => undefined);
    });
  });
});
