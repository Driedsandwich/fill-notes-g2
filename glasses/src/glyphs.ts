// Glyphs checked against nickustinov/even-g2-notes docs/display.md (2026-11-24):
//   supported:   U+00B7 middle dot, U+2501 and U+2500 box lines
//   unsupported: U+2713 check mark (Dingbats block is absent) -> a supported "●" is used instead
//   not listed:  U+2212 minus sign -> ASCII "-" is used
// Characters outside the firmware font are skipped silently, so keep this list short and ASCII-leaning.
export const DOT = '·'
export const MINUS = '-'
export const CHECK = '●'
export const BAR_FULL = '━'
export const BAR_EMPTY = '─'
export const CURSOR = '>'
