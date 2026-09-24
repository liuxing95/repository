import { test, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, access } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { fixture } from "../helpers";
import { parserProfile } from "../../apps/service/src/ingestion/parser";
test("actual parser OS profile denies home/temp reads, filesystem writes, child execution and network", async () => {
  const f = await fixture();
  const secret = join(f.root, "secret");
  const output = join(f.root, "output");
  await writeFile(secret, "private material");
  let accepted = 0;
  const server = createServer((socket) => {
    accepted++;
    socket.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const program = `const fs=require('node:fs'),cp=require('node:child_process'),net=require('node:net');const result={};for(const [name,fn] of Object.entries({read:()=>fs.readFileSync(${JSON.stringify(secret)}),write:()=>fs.writeFileSync(${JSON.stringify(output)},'bad'),child:()=>cp.execFileSync('/usr/bin/true')})){try{fn();result[name]='allowed'}catch{result[name]='denied'}}const socket=net.connect(${port},'127.0.0.1');socket.on('error',()=>{result.network='denied';console.log(JSON.stringify(result))});socket.on('connect',()=>{result.network='allowed';socket.end();console.log(JSON.stringify(result))});`;
    const { stdout } = await promisify(execFile)(
      "/usr/bin/sandbox-exec",
      ["-p", parserProfile([]), process.execPath, "-e", program],
      { env: { TZ: "UTC" }, timeout: 5000, killSignal: "SIGKILL" },
    );
    expect(JSON.parse(stdout)).toEqual({
      read: "denied",
      write: "denied",
      child: "denied",
      network: "denied",
    });
    expect(accepted).toBe(0);
    await expect(access(output)).rejects.toThrow();
  } finally {
    server.close();
    await f.close();
  }
});
