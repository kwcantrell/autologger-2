// Shared by the generated `.ts` fixtures in this directory. Hand-written — the
// only file here that is (web-api-shape-conformance, design D4).
//
// `as const` is what stops TypeScript widening a captured `"admin"` to
// `string`: a `.json` import widens, so a union-typed client field
// (`TeamRole`, `Session.session_status`, `Category.type`) produces a false
// positive against a `.json` fixture — D4's verified wrinkle. But `as const`
// also makes every array `readonly`, and `readonly T[]` is NOT assignable to
// `T[]`, so an as-const fixture would fail the conformance assignment for a
// reason that has nothing to do with the response shape.
//
// `Mutable<T>` strips the `readonly` back off while keeping the literal types
// — which is exactly the combination the conformance check needs. It is
// homomorphic (`{ -readonly [K in keyof T]: … }` with no array special case),
// so it maps a `readonly [A, B]` tuple to a mutable `[A, B]` tuple, which is
// assignable to `A[]`/`B[]`-typed client fields.
export type Mutable<T> = T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
