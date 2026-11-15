// The Codex CLI's model cache, read for the Model fields' suggestions.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codexModels, parseCodexCache } from '../src/models';

const cache = {
  fetched_at: '2026-11-15T10:43:41.105705500Z',
  client_version: '0.167.0',
  models: [
    { slug: 'gpt-6.1-sol', visibility: 'list' },
    { slug: 'gpt-reserve', visibility: 'hide' },
    { slug: 'gpt-5.6-luna', visibility: 'list' },
    { slug: 'gpt-5.6-luna', visibility: 'list' },
    { display_name: 'no slug' },
  ],
};

describe('parseCodexCache', () => {
  it('keeps the listed slugs once each, in order, and names the CLI version', () => {
    expect(parseCodexCache(cache)).toEqual({
      models: ['gpt-6.1-sol', 'gpt-5.6-luna'],
      source: 'codex CLI 0.167.0',
      fetchedAt: '2026-11-15T10:43:41.105705500Z',
    });
  });

  it('returns null for a file without models', () => {
    expect(parseCodexCache(null)).toBeNull();
    expect(parseCodexCache({ models: 'x' })).toBeNull();
    expect(parseCodexCache({ models: [{ slug: 'a', visibility: 'hide' }] })).toBeNull();
  });
});

describe('codexModels', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('reads models_cache.json from CODEX_HOME', () => {
    dir = mkdtempSync(join(tmpdir(), 'codex-home-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'models_cache.json'), JSON.stringify(cache));
    expect(codexModels({ CODEX_HOME: dir })?.models).toEqual(['gpt-6.1-sol', 'gpt-5.6-luna']);
  });

  it('returns null when the CLI has no cache', () => {
    dir = mkdtempSync(join(tmpdir(), 'codex-home-'));
    expect(codexModels({ CODEX_HOME: dir })).toBeNull();
  });
});
