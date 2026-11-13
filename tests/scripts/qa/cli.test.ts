import { describe, expect, it } from 'vitest';
import { main } from '../../../scripts/qa/run-personas.js';

describe('persona CLI validation', () => {
  it('rejects missing fixture before setup', async () => {
    await expect(main([])).rejects.toThrow('--fixture is required');
  });
  it('rejects invalid URL before loading fixture', async () => {
    await expect(
      main(['--base-url', 'file:///tmp/data', '--fixture', '/missing.ts'])
    ).rejects.toThrow('Invalid base URL');
  });
  it('rejects duplicate and unknown options', async () => {
    await expect(main(['--fixture', 'a', '--fixture', 'b'])).rejects.toThrow(
      'Usage'
    );
    await expect(main(['--unknown', 'a'])).rejects.toThrow('Usage');
  });
});

describe('request timeout validation', () => {
  it('rejects invalid timeout values before loading a fixture', async () => {
    for (const value of [
      '0',
      '-1',
      'NaN',
      'Infinity',
      '20ms',
      ' ',
      '2147483648',
    ]) {
      await expect(
        main(['--fixture', '/missing.ts', '--request-timeout-ms', value])
      ).rejects.toThrow('Request timeout');
    }
  });
});
