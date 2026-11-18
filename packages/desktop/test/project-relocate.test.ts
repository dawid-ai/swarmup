import { describe, expect, it, vi } from 'vitest';
import { relocateProjectHandler } from '../src/project-relocate.js';

describe('Edit project location', () => {
  it('lets only the app page pick a folder and preserves a swarmupd refusal', async () => {
    const pickFolder = vi.fn(async () => 'D:\\moved\\shop');
    const relocate = vi.fn(async (_root: string, _to: string): Promise<string[]> => ['shop']);
    const handle = relocateProjectHandler({
      fromPage: (event: string) => event === 'page',
      pickFolder,
      relocate,
    });

    await expect(handle('other', 'C:\\shop')).resolves.toEqual({
      ok: false,
      error: 'not allowed from this page',
    });
    expect(pickFolder).not.toHaveBeenCalled();

    await expect(handle('page', 'C:\\shop')).resolves.toEqual({ ok: true, data: ['shop'] });
    expect(relocate).toHaveBeenCalledWith('C:\\shop', 'D:\\moved\\shop');

    relocate.mockRejectedValueOnce(new Error('D:\\empty has no data root'));
    await expect(handle('page', 'C:\\shop')).resolves.toEqual({
      ok: false,
      error: 'D:\\empty has no data root',
    });
  });

  it('treats closing the system folder dialog as a cancellation', async () => {
    const relocate = vi.fn();
    const handle = relocateProjectHandler({
      fromPage: () => true,
      pickFolder: async () => null,
      relocate,
    });
    await expect(handle('page', 'C:\\shop')).resolves.toEqual({
      ok: false,
      error: 'cancelled',
    });
    expect(relocate).not.toHaveBeenCalled();
  });
});
