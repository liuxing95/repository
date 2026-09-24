// Encoding into ASCII keeps FTS tokenization independent from punctuation/Unicode rules.
export const TOKENIZER_VERSION = "han-bigram-symbol-v2";
const aliases: readonly (readonly string[])[] = [
  ["权限", "permission", "permissions"],
  ["重排", "rerank", "reranking"],
  ["nodejs", "node.js"],
  ["cpp", "c++"],
];
const encode = (prefix: string, term: string) =>
  prefix + Buffer.from(term).toString("hex");
export function tokenize(text: string, expand = false) {
  const normalized = text.normalize("NFKC").toLowerCase();
  const terms = new Set<string>();
  const symbols = new Set<string>();
  for (const run of normalized.matchAll(/\p{Script=Han}+/gu)) {
    const chars = Array.from(run[0]);
    for (let i = 0; i < chars.length; i++) {
      terms.add(encode("h", chars[i]!));
      if (i + 1 < chars.length)
        terms.add(encode("b", chars[i]! + chars[i + 1]!));
    }
  }
  for (const word of normalized.matchAll(/[a-z0-9_$]+/g))
    terms.add(encode("w", word[0]));
  for (const symbol of normalized.matchAll(
    /\/?[a-z0-9_$]+(?:(?:[.+/#:-]|::)[a-z0-9_$+.\/-]*)*/g,
  ))
    symbols.add(encode("s", symbol[0]));
  if (expand)
    for (const group of aliases)
      if (group.some((t) => normalized.includes(t)))
        for (const term of group) {
          const extra = tokenize(term);
          for (const token of extra.terms) terms.add(token);
          for (const token of extra.symbols) symbols.add(token);
        }
  return { terms: [...terms], symbols: [...symbols] };
}
export function queryCoverage(query: string, text: string) {
  const q = tokenize(
    query.replace(/什么|如何|是否|怎样|哪些|为什么|请问|多少|怎么/g, " "),
  );
  const strong = q.terms.some((t) => t.startsWith("b"))
    ? q.terms.filter((t) => !t.startsWith("h"))
    : q.terms;
  const present = new Set(tokenize(text, true).terms);
  return strong.filter((t) => present.has(t)).length / (strong.length || 1);
}
export function matchExpression(text: string) {
  const tokens = tokenize(
    text.replace(/什么|如何|是否|怎样|哪些|为什么|请问|多少|怎么/g, " "),
    true,
  );
  if (tokens.terms.some((t) => t.startsWith("b")))
    tokens.terms = tokens.terms.filter((t) => !t.startsWith("h"));
  if (
    /^[a-z0-9_$/][a-z0-9_$+./:#-]*$/i.test(text.trim()) &&
    /[+./:#]/.test(text)
  ) {
    return tokens.symbols.map((t) => `symbols : "${t}"`).join(" OR ");
  }
  return [...tokens.terms, ...tokens.symbols]
    .slice(0, 128)
    .map((t) => `"${t}"`)
    .join(" OR ");
}
