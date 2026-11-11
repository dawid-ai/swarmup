import { describe, expect, it } from 'vitest';
import { deleteEnvVars, envPairs, envVar } from '../src/env.js';

describe('environment names (AO-0199)', () => {
  it('reads SWARMUP_* first and falls back to OPS_* only when the new name is unset', () => {
    expect(envVar({ SWARMUP_AGENT: 'claude:qa', OPS_AGENT: 'codex:qa' }, 'AGENT')).toBe(
      'claude:qa',
    );
    expect(envVar({ OPS_AGENT: 'codex:qa' }, 'AGENT')).toBe('codex:qa');
    // An empty new value is set, so it wins: a caller can blank an inherited id.
    expect(envVar({ SWARMUP_AGENT: '', OPS_AGENT: 'codex:qa' }, 'AGENT')).toBe('');
    expect(envVar({}, 'AGENT')).toBeUndefined();
  });

  it('deletes both names and sets both for a child', () => {
    const env: NodeJS.ProcessEnv = { SWARMUP_RUN: 'a', OPS_RUN: 'b', KEEP: '1' };
    deleteEnvVars(env, ['RUN']);
    expect(env).toEqual({ KEEP: '1' });
    expect(envPairs({ AGENT: 'claude:qa', PARENT_RUN: undefined })).toEqual({
      SWARMUP_AGENT: 'claude:qa',
      OPS_AGENT: 'claude:qa',
    });
  });
});
