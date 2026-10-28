# Opening book

`openings.json` is generated from [lichess-org/chess-openings](https://github.com/lichess-org/chess-openings)
(CC0-1.0, public domain), files `a.tsv` – `e.tsv`.

Format: `{ names: ["<ECO>\t<name>", ...], book: { "<FEN placement> <side> <castling>": nameIndex | -1 } }`
— every position reached along a named line is a book position; `-1` means it has no name of its own.

Rebuild: put the TSV files and chess.js 0.10.2 (CommonJS) next to `build.cjs`, then
`node build.cjs <tsv dir> openings.json`.
