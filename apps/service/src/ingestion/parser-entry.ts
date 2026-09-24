import { parseWeb, parseText } from "./web-parser";
import { parsePdf } from "./pdf-parser";
import type { AcquisitionPlan } from "@kb/contracts";
async function run(input: {
  bytes: string;
  kind: AcquisitionPlan["kind"];
  title: string;
  url: string;
  encoding: string;
  path?: string;
  password?: string;
}) {
  const started = performance.now();
  try {
    const bytes = Buffer.from(input.bytes, "base64");
    if (bytes.length > 20_000_000) throw new Error("LIMIT");
    const parsed =
      input.kind === "pdf"
        ? await parsePdf(bytes, input.title, input.password)
        : ["web", "collection"].includes(input.kind)
          ? parseWeb(bytes, input.url, input.encoding)
          : parseText(bytes, input.title, input.encoding, input.path);
    parsed.peakMemoryBytes = process.resourceUsage().maxRSS * 1024;
    parsed.durationMs = performance.now() - started;
    if (Buffer.byteLength(JSON.stringify(parsed)) > 8_000_000)
      throw new Error("LIMIT");
    process.stdout.write(
      "\nKB_RESULT=" + JSON.stringify({ ok: true, parsed }) + "\n",
    );
  } catch {
    process.stdout.write("\nKB_RESULT=" + JSON.stringify({ ok: false }) + "\n");
  }
}
let payload = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  payload += chunk;
  if (payload.length > 28_000_000) process.exit(1);
});
process.stdin.on("end", () => {
  void run(JSON.parse(payload)).then(() => {
    payload = "";
  });
});
