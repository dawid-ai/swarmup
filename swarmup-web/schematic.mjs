#!/usr/bin/env node
// Draws the home page's schematic (the <svg class="net"> in pages/home.html) from the node and
// line lists below and writes it into the page, formatted with Prettier. Edit the lists here, not
// the SVG in the page. Every line and node carries its stage classes (s0 plan, s1 build, s2 review,
// s3 ship), so assets/site.css can light one stage at a time and assets/site.js can switch stages.
//
// Usage: node swarmup-web/schematic.mjs [--check]
//   --check  changes nothing; exits 1 when the page's schematic differs from these lists.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';

const page = join(dirname(fileURLToPath(import.meta.url)), 'pages', 'home.html');
const check = process.argv.includes('--check');

const W = 720;
const H = 680;
// Each provider's color, from assets/site.css.
const C = {
  you: 'var(--you)',
  claude: 'var(--claude)',
  codex: 'var(--codex)',
  grok: 'var(--grok)',
  gemini: 'var(--gemini)',
  jev: 'var(--jev)',
  opsd: 'var(--orchestrator)',
  queue: 'var(--fg)',
};

// Agents: center on a 40 px grid, label side, the stages they take part in.
const NODES = [
  { x: 360, y: 40, label: 'human:you', kind: 'you', side: 'right', stages: [0] },
  { x: 160, y: 120, label: 'claude:pm', kind: 'claude', side: 'right', stages: [0] },
  { x: 560, y: 120, label: 'jev:triage', kind: 'jev', side: 'left', stages: [0] },
  { x: 80, y: 340, label: 'claude:engineer', kind: 'claude', side: 'below', stages: [1, 2] },
  { x: 260, y: 340, label: 'codex:engineer', kind: 'codex', side: 'below', stages: [1, 2] },
  { x: 460, y: 340, label: 'grok:engineer', kind: 'grok', side: 'below', stages: [1, 2] },
  { x: 640, y: 340, label: 'gemini:qa', kind: 'gemini', side: 'below', stages: [1, 2] },
  { x: 140, y: 580, label: 'claude:reviewer', kind: 'claude', side: 'below', stages: [2, 3] },
  { x: 360, y: 580, label: 'codex:reviewer', kind: 'codex', side: 'below', stages: [2, 3] },
  { x: 580, y: 580, label: 'grok:reviewer', kind: 'grok', side: 'below', stages: [2, 3] },
];
// Boxes: the queue every task passes through, and the orchestrator that runs checks and merges.
const BOXES = [
  { x: 300, y: 208, w: 120, h: 44, label: 'queue', kind: 'queue', stages: [0, 1, 3] },
  { x: 288, y: 432, w: 144, h: 36, label: 'orchestrator', kind: 'opsd', stages: [3] },
];

// Lines: stage, whose color, and a right-angle path between node centers and box edges. A review
// line always ends at a reviewer from another provider.
const LINES = [
  [0, 'you', 'M360 40 V80 H160 V120'],
  [0, 'you', 'M360 40 V80 H560 V120'],
  [0, 'claude', 'M160 120 V230 H300'],
  [0, 'jev', 'M560 120 V230 H420'],
  [1, 'claude', 'M310 252 V290 H80 V340'],
  [1, 'codex', 'M340 252 V310 H260 V340'],
  [1, 'grok', 'M380 252 V310 H460 V340'],
  [1, 'gemini', 'M410 252 V290 H640 V340'],
  [2, 'codex', 'M80 340 V640 H360 V580'],
  [2, 'grok', 'M260 340 V520 H580 V580'],
  [2, 'claude', 'M460 340 V540 H140 V580'],
  [2, 'grok', 'M640 340 V600 H580'],
  [3, 'opsd', 'M140 580 V500 H360 V468'],
  [3, 'opsd', 'M580 580 V500 H360'],
  [3, 'opsd', 'M360 580 V468'],
  [3, 'opsd', 'M360 432 V252'],
];

const TITLE =
  'How a task moves through a swarm of agents from several AI providers: you, the PM agent and a ' +
  'triage agent plan it, engineers build it in parallel, a reviewer from another provider checks ' +
  'it, and the orchestrator runs the checks and merges it.';

const cls = (base, stages) => [base, ...stages.map((s) => `s${s}`)].join(' ');

function svg() {
  const out = [
    `<svg class="net" data-stage="0" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="net-title">`,
    `<title id="net-title">${TITLE}</title>`,
    '<g class="grid" aria-hidden="true">',
  ];
  for (let x = 0; x <= W; x += 40) out.push(`<line x1="${x}" y1="0" x2="${x}" y2="${H}"></line>`);
  for (let y = 0; y <= H; y += 40) out.push(`<line x1="0" y1="${y}" x2="${W}" y2="${y}"></line>`);
  out.push('</g>');
  for (const [stage, kind, d] of LINES) {
    // A packet runs along each lit line; the speed varies a little so they don't move in step.
    const dur = (1.4 + ((d.match(/\d+/g).length * 40 + d.length) % 9) / 10).toFixed(1);
    out.push(
      `<g class="e s${stage}" style="--c: ${C[kind]}"><path class="edge" d="${d}"></path>` +
        `<path class="flow" d="${d}"></path><rect class="packet" x="-3" y="-3" width="6" height="6">` +
        `<animateMotion dur="${dur}s" repeatCount="indefinite" path="${d}"></animateMotion></rect></g>`,
    );
  }
  for (const b of BOXES) {
    out.push(
      `<g class="${cls('hub', b.stages)}" style="--c: ${C[b.kind]}"><rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}"></rect>` +
        `<text x="${b.x + b.w / 2}" y="${b.y + b.h / 2 + 5}" text-anchor="middle">${b.label}</text></g>`,
    );
  }
  for (const n of NODES) {
    let tx = n.x;
    let ty = n.y + 5;
    let anchor = 'start';
    if (n.side === 'right') tx = n.x + 16;
    if (n.side === 'left') {
      tx = n.x - 16;
      anchor = 'end';
    }
    if (n.side === 'below') {
      ty = n.y + 30;
      anchor = 'middle';
    }
    out.push(
      `<g class="${cls('n', n.stages)}" style="--c: ${C[n.kind]}"><rect x="${n.x - 7}" y="${n.y - 7}" width="14" height="14"></rect>` +
        `<text x="${tx}" y="${ty}" text-anchor="${anchor}">${n.label}</text></g>`,
    );
  }
  out.push('</svg>');
  return out.join('\n');
}

const html = readFileSync(page, 'utf8');
const start = html.indexOf('<svg class="net"');
const end = html.indexOf('</svg>', start);
if (start < 0 || end < 0) {
  console.error(`schematic: no <svg class="net"> in ${page}`);
  process.exit(2);
}
const raw = html.slice(0, start) + svg() + html.slice(end + '</svg>'.length);
const options = (await prettier.resolveConfig(page)) ?? {};
const next = await prettier.format(raw, { ...options, filepath: page });
if (check) {
  if (next !== html) {
    console.error(
      'schematic: pages/home.html differs from swarmup-web/schematic.mjs; run npm run web:schematic',
    );
    process.exit(1);
  }
  console.log('schematic: pages/home.html matches');
} else {
  writeFileSync(page, next);
  console.log(next === html ? 'schematic: unchanged' : 'schematic: pages/home.html updated');
}
