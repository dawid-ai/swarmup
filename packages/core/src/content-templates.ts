// The `campaign` and `content` project templates (W8): a plain folder of Markdown that SwarmUp
// keeps in git, with a brand voice, a claims file, rubrics, a calendar and a seeded project map.
// `main` means approved, not live: publishing is a person's step (`swarmup published`).
import type { CheckName, DoneWhenEntry } from './criteria.js';
import type { PlannedTask, ProjectTemplate } from './adopt.js';

const CONTENT_AGENTS_MD = `# Instructions for agents working on {{name}}

{{name}} is content, not code: Markdown drafts, a brand voice, a claims file and the rubrics the
work is judged by. SwarmUp tracks the work in its task store; use the \`swarmup\` command and never
edit task files by hand.

## Rules

- **Never publish.** Do not post, send, schedule or upload anything, and do not sign in to a
  publishing account. \`main\` means approved, not live: a person publishes and records it with
  \`swarmup published\`.
- **Cite every claim.** A number, a feature, a date or a comparison must have a row in
  \`facts/claims.md\` with its source. If it has none, add the row with the source in the same
  branch, or leave the claim out.
- **Write in the voice** of \`brand/voice.md\`. If it is still a placeholder, say so in the review
  request.
- Do not edit \`brand/\`, \`facts/\` or \`rubrics/\` unless the task asks for it: they are the
  yardsticks the work is judged by.
- Work on a branch per task and name the task id in commits.
- Finish with \`swarmup review ID\`, naming each piece with \`--artifact PATH\` (or a URL).

## Layout

- \`posts/\`: one Markdown file per piece, with front matter (\`channel\`, \`status\`, \`task\`).
- \`assets/\`: images and cards the posts use.
- \`calendar.md\`: what goes out where and when.
- \`brand/voice.md\`, \`facts/claims.md\`, \`rubrics/\`: the yardsticks.
- \`.swarmup/map/\`: the project map; update it when you add an area.
`;

const CONTENT_GITIGNORE = `out/
.DS_Store
Thumbs.db
.env
.env.*
`;

const VOICE_MD = `# Brand voice

Replace this placeholder with how {{name}} sounds. The editor and the brand-voice rubric judge
every draft against this file.

## Voice

Three to five traits, each with one line on what it means and one example sentence.

## Words we use

Plain words the audience uses.

## Words we avoid

Words that make the copy sound like everyone else's, such as hype words and filler.

## Examples

One short passage that sounds right, and one that does not, with why.
`;

const CLAIMS_MD = `# Claims

Every factual claim a draft makes needs a row here: what it says, where it comes from, and when
someone last checked the source. Drafts may only state what this table holds.

| Claim | Source | Checked |
| ----- | ------ | ------- |
`;

const CALENDAR_MD = `---
campaign: {{name}}
updated: YYYY-MM-DD
---

# Calendar

What goes out, where and when. One row per piece; \`task\` is its SwarmUp task id.

| Date | Channel | Piece | Task | Status |
| ---- | ------- | ----- | ---- | ------ |
`;

const POSTS_README = `# Posts

One Markdown file per piece, named \`<channel>-<slug>.md\`, such as \`x-launch-thread.md\`. Each
starts with front matter:

\`\`\`yaml
---
channel: x # x, linkedin, hn, blog, email, ...
status: draft # draft, approved, published
task: AB-0004
---
\`\`\`

A thread or a multi-part post separates its parts with a line that holds only \`---\`.
`;

const ASSETS_README = `# Assets

Images, social cards and other files the posts use. Name them after the post they belong to.
Every image a post uses needs alt text in the post.
`;

/** A rubric file in the format `rubric.ts` reads: a 0 to 4 scale with anchors for each score. */
function rubric(
  id: string,
  title: string,
  criteria: Array<{ id: string; weight: number; describe: string }>,
  files: string[],
  anchors: string,
): string {
  const lines = [
    '---',
    `id: ${id}`,
    'scale: { min: 0, max: 4 }',
    'criteria:',
    ...criteria.flatMap((c) => [
      `  - id: ${c.id}`,
      `    weight: ${c.weight}`,
      `    describe: '${c.describe.replace(/'/g, "''")}'`,
    ]),
    `inputs: [diff, task, repo, { files: [${files.map((f) => `'${f}'`).join(', ')}] }]`,
    '---',
    '',
    `# ${title}`,
    '',
    'Score each criterion from 0 to 4 by the anchors. Pick the lowest anchor whose description',
    'fits: a draft that meets most of 3 but fails one point of it is a 2.',
    '',
    anchors.trim(),
    '',
  ];
  return lines.join('\n');
}

const BRAND_VOICE = rubric(
  'brand-voice',
  'Brand voice',
  [
    {
      id: 'voice',
      weight: 0.5,
      describe: 'The draft sounds like brand/voice.md: its traits, its words, its sentence length.',
    },
    {
      id: 'banned',
      weight: 0.3,
      describe: 'The draft uses none of the words brand/voice.md says to avoid, and no filler.',
    },
    {
      id: 'clarity',
      weight: 0.2,
      describe: 'A reader who skims gets the point from the first sentence.',
    },
  ],
  ['brand/voice.md'],
  `
## Anchors

- **4**: Reads as if the voice guide's author wrote it. Every trait shows; no avoided word; the
  first sentence carries the point.
- **3**: On voice throughout, with one weak sentence (a stock phrase, a long aside). No avoided
  word.
- **2**: Mostly on voice, but one avoided word or two stock phrases, or the point is in the second
  paragraph.
- **1**: Generic: it could be any company's copy. Several avoided words or hype words.
- **0**: Contradicts the voice guide (a tone it rules out), or the guide is a placeholder and the
  draft does not say so.
`,
);

const CLAIM_ACCURACY = rubric(
  'claim-accuracy',
  'Claim accuracy',
  [
    {
      id: 'sourced',
      weight: 0.6,
      describe:
        'Every factual claim (number, feature, date, comparison) has a row in facts/claims.md.',
    },
    {
      id: 'faithful',
      weight: 0.4,
      describe:
        'Each claim says no more than its row: no rounding up, no broader scope, no new tense.',
    },
  ],
  ['facts/claims.md'],
  `
## Anchors

- **4**: Every claim matches a row word for word in meaning. Nothing stated that the table lacks.
- **3**: Every claim has a row; one is phrased a little stronger than its row but stays true.
- **2**: One claim has no row, or one claim overstates its row (a "will" for a "may", a rounded
  number).
- **1**: Several claims have no row, or one claim is false against its source.
- **0**: The draft rests on a claim that is false or invented.

Quote each claim that scores it down, and the row it should match, in your reasons.
`,
);

const CHANNEL_FIT = rubric(
  'channel-fit',
  'Channel fit',
  [
    {
      id: 'format',
      weight: 0.4,
      describe:
        "The draft fits the channel's format: length, structure, links, hashtags and images.",
    },
    {
      id: 'audience',
      weight: 0.4,
      describe:
        "It speaks to the channel's readers: what they know, what they want, how they talk.",
    },
    {
      id: 'ask',
      weight: 0.2,
      describe: 'It ends with one clear next step that suits the channel.',
    },
  ],
  ['calendar.md'],
  `
## Anchors

The channel is the post's \`channel\` front matter, else the task's title.

- **4**: A regular of the channel would take it for a native post: format, length and register
  are right, and the next step suits the place (a link on X, a question on Hacker News).
- **3**: Fits the channel, with one slip: a hashtag too many, a paragraph too long.
- **2**: Readable there, but written for another place: a press-release tone on Hacker News, a
  LinkedIn post cut into a thread.
- **1**: Breaks a channel rule: over the length limit, marketing language where it is frowned on,
  no link where one is expected.
- **0**: Would be removed or flagged on the channel.
`,
);

/** A map node file. */
function node(
  kind: string,
  summary: string,
  covers: string[],
  links: string[],
  title: string,
  body: string,
): string {
  return [
    '---',
    `kind: ${kind}`,
    `summary: '${summary.replace(/'/g, "''")}'`,
    `covers: [${covers.map((c) => `'${c}'`).join(', ')}]`,
    `links: [${links.join(', ')}]`,
    '---',
    '',
    `# ${title}`,
    '',
    body.trim(),
    '',
  ].join('\n');
}

/** The map nodes a content project starts with, by path under `.swarmup/map/`. */
function mapNodes(campaign: boolean): Record<string, string> {
  const areas = [
    'voice',
    'claims',
    'rubrics',
    'posts',
    'assets',
    ...(campaign ? ['calendar'] : []),
  ];
  const nodes: Record<string, string> = {
    'index.md': [
      '---',
      'kind: root',
      `type: campaign`,
      `summary: '{{name}}: ${campaign ? 'a campaign' : 'content'} written by agents, approved by a person, published by a person'`,
      `covers: ['README.md', 'AGENTS.md', '.gitignore']`,
      `links: [${areas.join(', ')}]`,
      '---',
      '',
      '# {{name}}',
      '',
      'Drafts live in `posts/` and go through review on a branch. `main` holds approved work;',
      'a person publishes it and records it with `swarmup published`.',
      '',
      'The yardsticks: `voice` (how it sounds), `claims` (what it may say) and `rubrics` (how the',
      'judge scores it). Agents do not change them unless a task asks.',
      '',
    ].join('\n'),
    'voice.md': node(
      'message',
      'How {{name}} sounds: traits, words to use and avoid, examples',
      ['brand/'],
      ['claims', '/rubrics'],
      'Brand voice',
      'The voice guide in `brand/voice.md`, and source material in `brand/` beside it. The\nbrand-voice rubric reads it.',
    ),
    'claims.md': node(
      'message',
      'Every claim a draft may make, with its source and when it was checked',
      ['facts/'],
      ['voice', '/rubrics'],
      'Claims',
      'A draft states only what `facts/claims.md` holds. The claim-accuracy rubric reads it.',
    ),
    'rubrics.md': node(
      'metric',
      'The rubrics the judge scores drafts by: brand voice, claim accuracy, channel fit',
      ['rubrics/'],
      ['voice', 'claims'],
      'Rubrics',
      'Each rubric is a 0 to 4 scale with anchors, read from `main` at merge so a branch cannot\nchange the rubric it is judged by.',
    ),
    'posts.md': node(
      'channel',
      'The drafts, one Markdown file per piece with channel, status and task front matter',
      ['posts/'],
      ['assets', ...(campaign ? ['calendar'] : [])],
      'Posts',
      'One file per piece, named `<channel>-<slug>.md`. Parts of a thread are separated by a line\nwith only `---`.',
    ),
    'assets.md': node(
      'asset',
      'Images and social cards the posts use',
      ['assets/'],
      ['posts'],
      'Assets',
      'Named after the post they belong to; each image needs alt text where a post uses it.',
    ),
  };
  if (campaign) {
    nodes['calendar.md'] = node(
      'calendar',
      'What goes out, where and when, one row per piece with its task',
      ['calendar.md'],
      ['posts'],
      'Calendar',
      'The plan of the campaign: date, channel, piece, task and status.',
    );
  }
  return nodes;
}

/** Files of a content project, by path; `{{name}}` becomes the project name. */
function contentFiles(campaign: boolean): Record<string, string> {
  const files: Record<string, string> = {
    'README.md': `# {{name}}\n\n${campaign ? 'A campaign' : 'Content'} written with SwarmUp. Drafts are in \`posts/\`; \`main\` holds approved work, and a person publishes it.\n\nRun \`swarmup list\` to see the work.\n`,
    'AGENTS.md': CONTENT_AGENTS_MD,
    '.gitignore': CONTENT_GITIGNORE,
    'brand/voice.md': VOICE_MD,
    'facts/claims.md': CLAIMS_MD,
    'rubrics/brand-voice.md': BRAND_VOICE,
    'rubrics/claim-accuracy.md': CLAIM_ACCURACY,
    'rubrics/channel-fit.md': CHANNEL_FIT,
    'posts/README.md': POSTS_README,
    'assets/README.md': ASSETS_README,
  };
  if (campaign) files['calendar.md'] = CALENDAR_MD;
  return files;
}

/** The map files of a content project, by path from the project top. */
export function contentMapFiles(campaign: boolean): Record<string, string> {
  return Object.fromEntries(
    Object.entries(mapNodes(campaign)).map(([p, text]) => [`.swarmup/map/${p}`, text]),
  );
}

const check = (
  id: string,
  name: string,
  args: Record<string, unknown>,
  text?: string,
): DoneWhenEntry => ({
  id,
  kind: 'check',
  check: name as CheckName,
  args,
  ...(text ? { text } : {}),
});

const rubricOf = (id: string, file: string): DoneWhenEntry => ({
  id,
  kind: 'rubric',
  rubric: `rubrics/${file}.md`,
  pass: 0.7,
});

/** The first tasks of a content project. `campaign` adds the calendar. */
function contentTasks(campaign: boolean): PlannedTask[] {
  const tasks: PlannedTask[] = [
    {
      title: 'Write the brand voice of {{name}}',
      type: 'docs',
      priority: 'p1',
      owner: 'claude:writer',
      labels: ['yardstick'],
      body: [
        'Fill in `brand/voice.md` from what the person gives you and the material in `brand/`.',
        '',
        '- Keep the four headings; replace the placeholder text under each.',
        '- Ask the person for two pieces they like and one they do not, if `brand/` has none.',
        '- The person reviews this: it is the yardstick every draft is judged by.',
      ].join('\n'),
      done_when: [
        check('headings', 'heading-structure', {
          path: 'brand/voice.md',
          headings: [
            '# Brand voice',
            '## Voice',
            '## Words we use',
            '## Words we avoid',
            '## Examples',
          ],
        }),
        check('filled', 'contains', {
          path: 'brand/voice.md',
          text: ['Replace this placeholder'],
          expect: false,
        }),
        { id: 'sounds-right', kind: 'human', ask: 'Does brand/voice.md sound like {{name}}?' },
      ],
    },
    {
      title: 'Collect the claims {{name}} may make',
      type: 'docs',
      priority: 'p1',
      owner: 'claude:researcher',
      labels: ['yardstick'],
      body: [
        'Fill `facts/claims.md` with every fact the drafts may state, each with its source (a file, a',
        'URL, a release) and the date you checked it.',
        '',
        '- One claim per row; say it the way a draft may say it, no stronger.',
        '- Leave out what you cannot source.',
      ].join('\n'),
      done_when: [
        check(
          'rows',
          'regex',
          {
            path: 'facts/claims.md',
            pattern: '^\\|[^|\\n]+\\|[^|\\n]*\\S[^|\\n]*\\|\\s*\\d{4}-\\d{2}-\\d{2}\\s*\\|',
            flags: 'm',
          },
          'at least one row with a source and a checked date',
        ),
        {
          id: 'stands',
          kind: 'human',
          ask: 'Is every row of facts/claims.md a claim you stand behind?',
        },
      ],
    },
  ];
  if (campaign) {
    tasks.push({
      title: 'Plan the calendar of {{name}}',
      type: 'content',
      priority: 'p2',
      owner: 'claude:writer',
      after: [0],
      body: 'One row per piece in `calendar.md`: date, channel, piece, task and status. Set `updated` in the front matter.',
      done_when: [
        check('front-matter', 'front-matter', {
          path: 'calendar.md',
          keys: ['campaign', 'updated'],
          match: { updated: '^\\d{4}-\\d{2}-\\d{2}$' },
        }),
        check('rows', 'regex', {
          path: 'calendar.md',
          pattern: '^\\|\\s*\\d{4}-\\d{2}-\\d{2}\\s*\\|',
          flags: 'm',
        }),
      ],
    });
  }
  const draft = tasks.length;
  tasks.push(
    {
      title: 'Draft the first post of {{name}}',
      type: 'content',
      priority: 'p2',
      owner: 'claude:writer',
      review: 'codex:editor',
      after: [0, 1],
      body: [
        'Write the first piece in `posts/<channel>-<slug>.md`, with front matter `channel`, `status:',
        'draft` and `task`. State only claims that `facts/claims.md` holds.',
        '',
        'Finish with `swarmup review` and `--artifact posts/<file>.md`.',
      ].join('\n'),
      done_when: [
        check('exists', 'file-exists', { path: 'posts/*-*.md' }),
        check('front-matter', 'front-matter', {
          path: 'posts/*-*.md',
          keys: ['channel', 'status', 'task'],
          match: { status: '^(draft|approved|published)$' },
        }),
        rubricOf('voice', 'brand-voice'),
        rubricOf('claims', 'claim-accuracy'),
        rubricOf('channel', 'channel-fit'),
      ],
    },
    {
      title: 'Publish the first post of {{name}}',
      type: 'publish',
      priority: 'p2',
      after: [draft],
      body: [
        'Post the approved piece from `main` yourself, then record it:',
        '',
        '```sh',
        'swarmup published <ID> --url <where it went live> --artifact posts/<file>.md',
        '```',
      ].join('\n'),
      done_when: [
        {
          id: 'live',
          kind: 'check',
          check: 'url-ok',
          args: { url: '{url}' },
          when: 'publish',
          text: 'the published URL answers',
        },
      ],
    },
  );
  return tasks;
}

/** The content templates of `swarmup new-project`. */
export const CONTENT_TEMPLATES: ProjectTemplate[] = [
  {
    id: 'campaign',
    description:
      'a marketing campaign: posts, a calendar, brand voice, claims and rubrics; a person publishes',
    agents: [
      { id: 'claude:writer', why: 'drafts posts and long copy' },
      { id: 'claude:copywriter', why: 'short copy, titles and calls to action' },
      { id: 'claude:researcher', why: 'sources the claims' },
      { id: 'codex:editor', why: 'reviews drafts against voice, claims and channel' },
      { id: 'claude:pm', why: 'plans the campaign and answers questions' },
    ],
    files: contentFiles(true),
    map: contentMapFiles(true),
    workspaceTypes: ['task', 'docs', 'content'],
    mergeChecks: ['swarmup map check --base main'],
    testChanges: ['brand/**', 'facts/**', 'rubrics/**'],
    tasks: contentTasks(true),
  },
  {
    id: 'content',
    description:
      'content such as a blog or a newsletter: brand voice, claims and rubrics; a person publishes',
    agents: [
      { id: 'claude:writer', why: 'drafts the pieces' },
      { id: 'claude:researcher', why: 'sources the claims' },
      { id: 'codex:editor', why: 'reviews drafts against voice, claims and channel' },
      { id: 'claude:pm', why: 'plans the work and answers questions' },
    ],
    files: contentFiles(false),
    map: contentMapFiles(false),
    workspaceTypes: ['task', 'docs', 'content'],
    mergeChecks: ['swarmup map check --base main'],
    testChanges: ['brand/**', 'facts/**', 'rubrics/**'],
    tasks: contentTasks(false),
  },
];
