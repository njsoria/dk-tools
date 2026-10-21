# YouTube transcript

A command that gets the transcript of a YouTube video and prints it, or saves it,
as markdown, plain text, SRT or JSON. The markdown form is made to hand to an
agent: a header with the title, channel and link, then paragraphs that each
begin with the time they start, so a point it pulls out can be traced back to
the moment in the video.

It reads the same caption tracks the YouTube player does. It needs no login, no
API key and no packages, and a YouTube Premium account doesn't change what it
can get.

## Run it

Node 22 or later.

```bash
node yt-transcript/bin/yt-transcript.mjs https://www.youtube.com/watch?v=VIDEO_ID
```

Any watch, `youtu.be`, shorts, embed or live link works, and so does the bare
11-character id. Give it several and it does each in turn.

| Option | What it does |
| --- | --- |
| `--lang <code>` | Caption language, `en` by default. A human-made track wins over an automatic one, and an exact code over a regional one |
| `--format <name>` | `md` (default), `text`, `srt` or `json` |
| `--save` | Write each transcript to a file and print its path |
| `--out-dir <dir>` | Where `--save` writes. Default `~/.local/share/yt-transcript` |
| `--window <secs>` | Seconds per timestamped paragraph in `md`. Default 60 |
| `--list` | List the caption languages a video has, and stop |

## Pull the useful parts out of a talk

Save the transcript, then give the file to Claude with the question:

```bash
node yt-transcript/bin/yt-transcript.mjs --save <link>
```

Then ask for what you want from it: "Read this transcript and list each
practice worth adopting in our setup, with the timestamp it comes from, and say
which of our CLAUDE.md rules, hooks or skills it would change."

## What it can't do

- A video with captions switched off has no transcript to read. The command says
  so and lists what it did find.
- Age-restricted, members-only and private videos are refused without a login.
  For one of those, `yt-dlp --write-auto-subs --skip-download --cookies-from-browser chrome <link>`
  fetches the captions with your signed-in browser, and you run it yourself.
- Automatic captions are a machine's guess: product names and code terms are
  often misspelled. Check a name before quoting it.
- It talks to an endpoint YouTube doesn't document. If YouTube changes it, the
  command fails loudly and `lib/youtube.mjs` is the one file to fix.

## Test

```bash
cd yt-transcript && npm test
```

The tests cover link parsing, track choice, caption parsing and the output
formats. They don't call YouTube.
