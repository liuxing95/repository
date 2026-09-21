import { Scope } from "@kb/contracts";
export function compareScope(
  a: Scope,
  b: Scope,
): "overlap" | "disjoint" | "unknown" {
  let unknown = false;
  for (const key of Object.keys(a) as (keyof Scope)[]) {
    if (a[key] == null || b[key] == null) unknown = true;
    else if (a[key] !== b[key]) return "disjoint";
  }
  return unknown ? "unknown" : "overlap";
}
// A query only constrains explicitly supplied fields; missing source fields stay unknown.
export function matchScope(
  query: Scope,
  source: Scope,
): "overlap" | "disjoint" | "unknown" {
  let unknown = false;
  for (const key of Object.keys(query) as (keyof Scope)[]) {
    if (query[key] == null) continue;
    if (source[key] == null) unknown = true;
    else if (query[key] !== source[key]) return "disjoint";
  }
  return unknown ? "unknown" : "overlap";
}
