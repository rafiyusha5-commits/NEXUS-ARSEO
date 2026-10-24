# Local brand fonts

Unmodified variable TrueType originals from `google/fonts`, pinned to commit
`e7db6ca603fd4862010383ff17ffd6cc4ffac1c0` (downloaded 2026-10-24):

- [Golos Text](https://github.com/google/fonts/blob/e7db6ca603fd4862010383ff17ffd6cc4ffac1c0/ofl/golostext/GolosText%5Bwght%5D.ttf), with `GolosText-OFL.txt`.
- [Jost](https://github.com/google/fonts/blob/e7db6ca603fd4862010383ff17ffd6cc4ffac1c0/ofl/jost/Jost%5Bwght%5D.ttf), with `Jost-OFL.txt`.

Both retain their SIL Open Font License 1.1 and copyright notices. Font files
are not modified/subsetted. Latin and Cyrillic glyphs are included. The root
layout retains `--font-display`, `--font-body`, normal style, `display: swap`,
and the existing heading/body weight ranges. `next/font/local` emits assets
with the app, removing the build-time Google Fonts network dependency.

Keep the originals and their licenses together when updating. Full originals
are larger than CDN subsets; this is intentional for reproducible offline CI.
