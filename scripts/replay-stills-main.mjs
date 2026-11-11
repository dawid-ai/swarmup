// Electron main for scripts/replay-stills.mjs: rasterizes each SVG in the jobs file to a PNG of
// its own size. The page draws the SVG onto a canvas of that size and returns the PNG, so the
// result does not depend on the window or screen size (Windows clamps windows taller than the
// screen, which would squash 1080 x 1920).
import { app, BrowserWindow } from 'electron';
import { Buffer } from 'node:buffer';
import { readFileSync, writeFileSync } from 'node:fs';

const jobs = JSON.parse(readFileSync(process.argv[process.argv.length - 1], 'utf8'));

app.commandLine.appendSwitch('force-color-profile', 'srgb');

app.whenReady().then(async () => {
  let code = 0;
  const win = new BrowserWindow({ show: false, width: 400, height: 300 });
  try {
    await win.loadURL('data:text/html,<!doctype html><html><body></body></html>');
    for (const job of jobs) {
      const svg = readFileSync(job.svg, 'utf8');
      const dataUrl = await win.webContents.executeJavaScript(
        `new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => {
            const c = document.createElement('canvas');
            c.width = ${job.width};
            c.height = ${job.height};
            c.getContext('2d').drawImage(img, 0, 0, ${job.width}, ${job.height});
            resolve(c.toDataURL('image/png'));
          };
          img.onerror = () => reject(new Error('the SVG did not load'));
          img.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(svg).toString('base64'))};
        })`,
        true,
      );
      writeFileSync(job.png, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
    }
  } catch (err) {
    console.error(err);
    code = 1;
  }
  win.destroy();
  app.exit(code);
});
