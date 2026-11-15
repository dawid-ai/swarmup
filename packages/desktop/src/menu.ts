/**
 * The window has no menu bar (AO-0340). Windows and Linux get no application menu at all; macOS
 * keeps a minimal one in its system bar, since Cmd+C, Cmd+V and Cmd+Q come from its Edit and app
 * menus there. Development builds keep reload and DevTools through `devShortcut`.
 */
import type { MenuItemConstructorOptions } from 'electron';

/** The application menu for `Menu.buildFromTemplate`, or null for none. */
export function appMenuTemplate(platform: NodeJS.Platform): MenuItemConstructorOptions[] | null {
  if (platform !== 'darwin') return null;
  return [{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }];
}

/** The keys of `Electron.Input` that `devShortcut` reads. */
export interface KeyInput {
  type: string;
  key: string;
  control: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
}

/**
 * The development shortcut a key press means, or null: Ctrl/Cmd+R and F5 reload,
 * Ctrl/Cmd+Shift+I and F12 toggle DevTools. Only key-down presses count.
 */
export function devShortcut(input: KeyInput): 'reload' | 'devtools' | null {
  if (input.type !== 'keyDown' || input.alt) return null;
  const mod = input.control || input.meta;
  const key = input.key.toLowerCase();
  if (key === 'f5' && !mod && !input.shift) return 'reload';
  if (key === 'f12' && !mod && !input.shift) return 'devtools';
  if (mod && key === 'r' && !input.shift) return 'reload';
  if (mod && key === 'i' && input.shift) return 'devtools';
  return null;
}
