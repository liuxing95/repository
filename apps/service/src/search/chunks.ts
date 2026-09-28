import type { ParseArtifact } from "@kb/contracts";

export const CHUNKER_VERSION = "bounded-overlap-v1";
export const MAX_CHUNK_CHARS = 2400;
export const CHUNK_OVERLAP_CHARS = 240;

export type RetrievalChunk = {
  start: number;
  end: number;
  text: string;
  heading: string[];
};

function safeEnd(text: string, end: number) {
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? ""))
    return end - 1;
  return end;
}

// The source text is immutable. Windows may overlap, while citations use the
// exact UTF-16 range from that text and are validated again when read.
export function retrievalChunks(parsed: ParseArtifact): RetrievalChunk[] {
  const groups: { start: number; end: number; heading: string[] }[] = [];
  for (const block of parsed.blocks) {
    if (!block.text.trim()) continue;
    const heading = block.locator.heading ?? [];
    const last = groups.at(-1);
    if (last && JSON.stringify(last.heading) === JSON.stringify(heading))
      last.end = block.end;
    else groups.push({ start: block.start, end: block.end, heading });
  }
  const chunks: RetrievalChunk[] = [];
  for (const group of groups) {
    let start = group.start;
    while (start < group.end) {
      const hardEnd = Math.min(group.end, start + MAX_CHUNK_CHARS);
      let end = hardEnd;
      if (hardEnd < group.end) {
        const candidates = parsed.blocks
          .filter((b) => b.end > start + MAX_CHUNK_CHARS / 2 && b.end <= hardEnd)
          .map((b) => b.end);
        if (candidates.length) end = candidates.at(-1)!;
        else {
          const tail = parsed.text.slice(start + MAX_CHUNK_CHARS / 2, hardEnd);
          const boundary = Math.max(tail.lastIndexOf("\n"), tail.lastIndexOf("。"));
          if (boundary >= 0) end = start + MAX_CHUNK_CHARS / 2 + boundary + 1;
        }
      }
      end = safeEnd(parsed.text, end);
      if (end <= start) end = safeEnd(parsed.text, hardEnd);
      const text = parsed.text.slice(start, end);
      if (text.trim()) chunks.push({ start, end, text, heading: group.heading });
      if (end >= group.end) break;
      const next = end - CHUNK_OVERLAP_CHARS;
      start = next > start ? next : end;
      if (start > group.start && /[\uDC00-\uDFFF]/.test(parsed.text[start] ?? ""))
        start--;
    }
  }
  return chunks;
}
