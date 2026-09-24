import { Sandbox } from "../runtime/sandbox";
import { SANDBOX_IMAGE } from "../runtime/sandbox";
import { AppError } from "../errors";
import { hashBytes } from "../ingestion/objects";
import { TRANSFORM_VERSION } from "./transform";

// The untrusted page text is data. The fixed builder has no dependency install,
// filesystem input beyond /input/data, network, script execution or Vault mount.
export const PUBLICATION_BUILD_PROGRAM = String.raw`
const fs = require('node:fs');
const pages = JSON.parse(fs.readFileSync('/input/data', 'utf8'));
const escape = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const shell = (title, body) => '<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'"><title>' + escape(title) + '</title><style>body{max-width:76ch;margin:3rem auto;padding:0 1rem;font:18px/1.7 system-ui;color:#202020}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}a{color:#154f87}</style></head><body>' + body + '</body></html>';
const index = pages.pages.map(p => '<li><a href="' + p.file + '">' + escape(p.title) + '</a></li>').join('');
fs.writeFileSync('/output/index.html', shell('公开副本', '<h1>公开副本</h1><ul>' + index + '</ul>'));
for (const p of pages.pages) fs.writeFileSync('/output/' + p.file, shell(p.title, '<nav><a href="index.html">返回目录</a></nav><pre>' + escape(p.body) + '</pre>'));
fs.writeFileSync('/output/search.json', JSON.stringify(pages.pages.map(p => ({title:p.title,path:p.file}))));
for (const a of pages.attachments) fs.writeFileSync('/output/' + a.path, a.content);
`;
export const BUILD_FINGERPRINT = hashBytes(
  JSON.stringify({
    adapter: "native-static-v1",
    image: SANDBOX_IMAGE,
    program: PUBLICATION_BUILD_PROGRAM,
    transform: TRANSFORM_VERSION,
    scanner: "public-scan-v1",
    attachments: "public-text-v1",
  }),
);
export async function buildPublication(
  pages: { title: string; body: string; file: string }[],
  attachments: { path: string; content: string }[] = [],
  sandbox = new Sandbox(),
) {
  if (pages.length < 1 || pages.length > 10 || attachments.length > 4)
    throw new AppError("VALIDATION", 400);
  const files = await sandbox.run(
    PUBLICATION_BUILD_PROGRAM,
    Buffer.from(JSON.stringify({ pages, attachments })),
    15_000,
  );
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return Object.fromEntries(
    Object.entries(files).map(([path, bytes]) => [path, decoder.decode(bytes)]),
  );
}
