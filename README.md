# claude-mods

Seven mods for [Claude Code](https://claude.com/claude-code). Each one is a plugin of function hooks: it draws panes, status lines and toasts inside Claude Code, in the terminal and in the desktop app's Code tab.

| Mod | What it does | How to use it |
| --- | --- | --- |
| **savvy-progress** | A live band above the prompt while Claude works: what it is doing now ("Reading format.ts · 4s"), elapsed time, steps, files read and changed, errors, and a progress bar: the real task list when Claude keeps one, otherwise a time bar guessed from how long your past turns took (clearly labelled a guess). A one-line summary after each turn. | Shows by itself. `/savvy-progress [on\|off]` |
| **skins** | Re-skins the spinner (glyphs, verbs, color), the turn's closing line and the prompt hints. Skins: `matrix`, `pirate`, `zen`, `retro`, `space`. Your choice is remembered. | `/skin` (picker), `/skin matrix`, `/skin off` |
| **filetree** | A live file-tree pane of the project. Marks the files Claude read (`R`), changed (`M`) and created (`A`) this session, and opens the folders they live in. | `/filetree`, `/filetree touched`, `/filetree all`, `/filetree close` |
| **cache-tax** | How well the prompt cache works, and the "tax": the money paid above the ideal where every input token is a cache read. Status line `cache 94% · tax $0.12`, a per-turn table, and a toast with the likely cause when the cache busts. | `/cache-tax`, `/cache-tax reset` |
| **blast-radius** | For each file Claude edits, the other files that import it; a flag on wide-reaching shell commands (`git reset --hard`, `rm -rf`, force push, ...). Shows only, never blocks. | `/blast-radius`, `/blast-radius session`, `/blast-radius clear` |
| **reflect** | Claude critiques its own recent work: what may be wrong or missed, risky assumptions, what to check next. One button puts the follow-ups in your prompt box (it never sends them). Optional auto mode, off by default. | `/reflect [focus]`, `/reflect show`, `/reflect auto on\|off` |
| **replay-theatre** | Records the session and plays it back like a film: scene by scene, step by step, with play/pause, step, speed and a timeline. | `/replay`, `/replay last`, `/replay copy`; keys `k` play, `j`/`l` step, `h`/`n` scene, `s` speed, `r` restart |

## Install

In a Claude Code terminal session, install any mod by name:

```
/plugin install savvy-progress --marketplace gauravruhela07/claude-mods
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session). Repeat for each mod you want: `skins`, `filetree`, `cache-tax`, `blast-radius`, `reflect`, `replay-theatre`.

A mod installed from a terminal at the user scope also loads in the desktop app's Code tab.

### Try one from a clone, without installing

```bash
git clone https://github.com/gauravruhela07/claude-mods
claude --plugin-dir claude-mods/filetree
```

## Notes

- **Cost:** only `reflect` calls the model, and only when you run `/reflect` or turn auto mode on. It asks over the session's own transcript, so most of it is served from the prompt cache.
- **cache-tax prices** are first-party API list prices as of 2026-10-11, in `cache-tax/hooks/prices.ts`. Claude Code does not report 5-minute and 1-hour cache writes apart, so all writes use the 5-minute price.
- **blast-radius** finds dependents with a text search (`rg`, falling back to `grep`) of import/require/from/include/use lines. It can miss aliased imports and Go's multi-line import blocks.
- These mods use the Claude Code function-hooks API, which is early access and can change between releases. They were built and tested on Claude Code 2.1.29x.

## Develop

Each mod folder holds `.claude-plugin/plugin.json`, `hooks/` (the hooks module), `types/index.d.ts` (its state contract) and `tests/`.

```bash
claude plugin validate filetree
claude plugin test filetree
```
