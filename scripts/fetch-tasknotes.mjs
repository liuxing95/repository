import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const root = ".context/tasknotes/plugin",
  version = "4.13.4";
await mkdir(root, { recursive: true });
for (const asset of ["main.js", "manifest.json", "styles.css"]) {
  const r = await fetch(
    `https://github.com/callumalpass/tasknotes/releases/download/${version}/${asset}`,
  );
  if (!r.ok) throw Error(`TaskNotes download: ${r.status}`);
  const bytes = Buffer.from(await r.arrayBuffer());
  if (
    asset === "main.js" &&
    createHash("sha256").update(bytes).digest("hex") !==
      "ae394af31dbad2566bc4a1635c354f669f23fc820e22e4eaf2f6239dfa89f4ca"
  )
    throw Error("Pinned TaskNotes artifact changed");
  if (
    asset === "manifest.json" &&
    JSON.parse(bytes.toString()).version !== version
  )
    throw Error("TaskNotes version mismatch");
  await writeFile(`${root}/${asset}`, bytes);
}
console.log(
  "TaskNotes 4.13.4 test assets verified; only isolated desktop tests load them.",
);
