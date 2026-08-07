// Mermaid label escaping (design.md D9; spec "Mermaid runs strict;
// navigation and text are injection-safe" — "every disk-derived string ...
// SHALL be escaped for mermaid label syntax before interpolation"). Every
// generator that interpolates a disk-derived string (component name, module
// path, relationship label, group name) into a mermaid label MUST route it
// through this helper first.
//
// Three characters are mermaid-syntax-significant inside a quoted label:
//  - `"` would terminate the quoted label early, letting the remaining text
//    escape into raw mermaid syntax.
//  - `#` starts a `#<decimal>;` character-entity reference (mermaid renders
//    `#35;` as `#`, `#60;`/`#62;` as `<`/`>`, etc.) — left unescaped, a
//    hostile string could construct its own entity out of literal `#`
//    characters.
//  - `|` delimits a `-->|label|` edge label outside of quotes; a literal `|`
//    inside label text risks terminating that delimiter early.
// `#` is neutralized FIRST, before `"`/`|` are turned into their own `#NN;`
// entities below — escaping in the other order would let a hostile string's
// literal `#quot;`/`#124;` substring be re-interpreted as one of the
// entities *this function* introduces (the same substitution-order class of
// bug as HTML-escaping `&` last instead of first).
//
// Angle brackets (`<`/`>`) are deliberately NOT escaped here: the client
// renders mermaid with `htmlLabels: false` under `securityLevel: 'strict'`
// (design.md D1), which is mermaid's own guarantee that label text is never
// interpreted as HTML regardless of its content — that is the layer
// responsible for angle-bracket safety, not this mermaid-*syntax* escaper.
//
// Embedded newlines are collapsed to a single space: mermaid's flowchart/
// state-diagram grammar is line-oriented, so an embedded `\n` in a
// disk-derived string (a multi-line description, say) would otherwise be
// parsed as the start of a new (invalid) statement.

const HASH_ENTITY = '#35;';
const QUOTE_ENTITY = '#quot;';
const PIPE_ENTITY = '#124;';

export function escapeMermaidLabel(text: string): string {
  return text
    .replace(/#/g, HASH_ENTITY)
    .replace(/"/g, QUOTE_ENTITY)
    .replace(/\|/g, PIPE_ENTITY)
    .replace(/\r\n|\r|\n/g, ' ')
    .trim();
}
