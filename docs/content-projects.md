# Content projects

A content project is a folder of Markdown, such as a campaign, a blog or a newsletter, that
agents draft, an editor reviews and a person publishes. SwarmUp keeps the folder in git, so a
draft is a branch, a version is a commit, approved means merged into `main`, and published is a
separate step only a person takes.

## Start one

```sh
swarmup new-project ../launch --template campaign --store ../tasks/launch --name launch \
  --prefix LC --human human:you
```

- `--template campaign` adds a calendar; `--template content` is the same without it.
- `--store` keeps the tasks in a folder apart, as `swarmup adopt --store` does. The project
  starts on `main` with the template committed, and your user config gains the root, the project
  as its code checkout, the merge check `swarmup map check --base main`, and
  `swarmupd.test_changes.<root>.checks` for `brand/**`, `facts/**` and `rubrics/**`, so a review
  flags a branch that changes a yardstick.
- Without `--store`, the tasks live in the project's own `.swarmup/`.
- `--no-tasks` files none of the template's first tasks, when you file your own.

Then turn on **Wake** for the roles you want to work on their own, and restart swarmupd.

## What the template holds

| Path                | What it is                                                                             |
| ------------------- | -------------------------------------------------------------------------------------- |
| `AGENTS.md`         | The rules for agents: never publish, cite every claim, write in the voice.             |
| `brand/voice.md`    | The voice guide: traits, words to use and avoid, examples. A placeholder at first.     |
| `facts/claims.md`   | Every claim a draft may make, with its source and the date it was checked.             |
| `rubrics/`          | `brand-voice`, `claim-accuracy` and `channel-fit`, each a 0 to 4 scale with anchors.   |
| `calendar.md`       | What goes out where and when (campaign only).                                          |
| `posts/`, `assets/` | One Markdown file per piece, with `channel`, `status` and `task` front matter; images. |
| `.swarmup/map/`     | The project map, with a node per area.                                                 |

Roles: `claude:writer` drafts, `claude:copywriter` writes short copy (proposed until you set it
active), `claude:researcher` sources claims, `codex:editor` reviews drafts and never edits, and
`claude:pm` plans. The root's `workspace_types` is `[task, docs, content]`, so drafts get their
own worktrees and branches.

## The workflow

1. **Brief.** You file or approve the work, with criteria that a check, a rubric or a person
   can answer.
2. **Draft.** The writer drafts on a branch and asks for review with `--artifact` for each piece.
3. **Review.** The editor reads each artifact at the reviewed commit (`swarmup artifact ID N`)
   and gives a result per criterion. The merge runs the checks and, with
   `swarmupd.judge.at_merge`, the rubrics, read from `main` so a branch cannot change its
   yardstick.
4. **Publish.** You post the approved piece from `main`, then record it:

   ```sh
   swarmup published LC-0010 --url https://x.com/you/status/1 --artifact posts/x-thread.md
   ```

   This tags the commit `published/LC-0010`, writes a `publish` event, closes the `publish` task
   and runs its `when: publish` criteria, such as a `url-ok` check on `{url}`.

## Checks that fit content

```yaml
done_when:
  - id: thread
    kind: check
    check: char-count
    args: { path: posts/x-thread.md, per: block, separator: '---', max: 280 }
  - id: banned
    kind: check
    check: contains
    args: { path: 'posts/*.md', text: [revolutionary, game-changer], expect: false }
  - id: link
    kind: check
    check: contains
    args: { path: posts/x-thread.md, text: github.com/you/project }
  - id: meta
    kind: check
    check: front-matter
    args: { path: 'posts/*.md', keys: [channel, status, task] }
  - id: voice
    kind: rubric
    rubric: rubrics/brand-voice.md
    pass: 0.7
```

See [Done when](protocol.md#done-when) for every check, and [Content work and
publishing](protocol.md#content-work-and-publishing) for the types, artifacts and the publish
record.
