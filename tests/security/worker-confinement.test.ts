import { expect, test } from "vitest";
import { homedir } from "node:os";
import { Sandbox } from "../../apps/service/src/runtime/sandbox";
import { WorkerBroker } from "../../apps/service/src/runtime/worker-broker";
import { Policy } from "../../apps/service/src/security/policy";
import { fixture, settings } from "../helpers";
import { Purpose } from "@kb/contracts";

const sandbox = new Sandbox();
test.skipIf(process.env.KB_TEST_OCI !== "1")(
  "real OCI blocks home, metadata, direct network, process exhaustion and symlink output",
  async () => {
    expect(await sandbox.available()).toBe(true);
    const program = `const fs=require('fs'),net=require('net'),cp=require('child_process');
 const result={home:false,metadata:false,network:false,pids:false};
 try{fs.readdirSync(${JSON.stringify(homedir())});result.home=true}catch{}
 const connect=host=>new Promise(r=>{const s=net.connect({host,port:80});s.setTimeout(500);s.once('connect',()=>{s.destroy();r(true)});s.once('error',()=>r(false));s.once('timeout',()=>{s.destroy();r(false)});});
 (async()=>{result.metadata=await connect('169.254.169.254');result.network=await connect('1.1.1.1');
 const children=[];for(let i=0;i<80;i++){const c=cp.spawn('/bin/sleep',['5']);children.push(c);c.on('error',e=>{if(e.code==='EAGAIN')result.pids=true;});}
 await new Promise(r=>setTimeout(r,200));children.forEach(c=>c.kill());
 fs.writeFileSync('/output/result.json',JSON.stringify(result));})();`;
    const files = await sandbox.run(program, Buffer.from("fixture"), 15_000);
    expect(JSON.parse(files["result.json"]!.toString())).toEqual({
      home: false,
      metadata: false,
      network: false,
      pids: true,
    });
    await expect(
      sandbox.run(
        "require('fs').symlinkSync('/etc/passwd','/output/escape')",
        Buffer.alloc(0),
      ),
    ).rejects.toThrow("FORBIDDEN");
    await expect(
      sandbox.run("while(true){}", Buffer.alloc(0), 500),
    ).rejects.toThrow("SANDBOX_LIMIT");
  },
  30_000,
);
test("broker requires an installed provider, fresh scope and budget before dispatch; cancellation retains bill", async () => {
  const f = await fixture();
  try {
    f.registry.saveSettings(settings, 1);
    const policy = new Policy(f.registry);
    policy.setSource({
      sourceId: "fixture",
      retracted: false,
      routes: Object.fromEntries(
        Purpose.options.map((p) => [p, p === "model" ? ["test-model"] : []]),
      ),
    });
    const principal = f.sessions.refresh(f.token);
    const job = f.jobs.enqueue(
      { operationKey: "broker-job", queue: "batch", kind: "diagnostic-check" },
      100,
    );
    const worker = f.jobs.claim("batch")!;
    const grant = {
      principal,
      version: f.registry.get().policyVersion,
      jobId: job.id,
      fence: worker.fence,
      purpose: "model" as const,
      routeId: "test-model",
      sourceIds: ["fixture"],
    };
    expect(() =>
      new WorkerBroker(policy, f.budget, f.jobs).grant(grant),
    ).toThrow("UNAVAILABLE");
    let calls = 0;
    const broker = new WorkerBroker(
      policy,
      f.budget,
      f.jobs,
      new Map([
        [
          "test-model",
          async () => {
            calls++;
            f.jobs.cancel(job.id);
            return {
              requestId: "real-request",
              cost: 50,
              value: "must discard",
            };
          },
        ],
      ]),
    );
    await expect(broker.call("forged", "call-1", 1)).rejects.toThrow("AUTH");
    expect(calls).toBe(0);
    const token = broker.grant(grant);
    await expect(broker.call(token, "call-1", 1)).rejects.toThrow(
      "STALE_WORKER",
    );
    expect(calls).toBe(1);
    expect(
      (
        f.store.db.prepare("SELECT actual FROM calls").get() as {
          actual: number;
        }
      ).actual,
    ).toBe(50);
  } finally {
    await f.close();
  }
});

test("session revocation blocks an already granted broker token before any provider request", async () => {
  const f = await fixture();
  try {
    f.registry.saveSettings(settings, 1);
    const policy = new Policy(f.registry);
    policy.setSource({
      sourceId: "fixture",
      retracted: false,
      routes: Object.fromEntries(
        Purpose.options.map((p) => [p, p === "model" ? ["test-model"] : []]),
      ),
    });
    const principal = f.sessions.refresh(f.token);
    const job = f.jobs.enqueue(
      {
        operationKey: "revoke-broker",
        queue: "batch",
        kind: "diagnostic-check",
      },
      100,
    );
    const worker = f.jobs.claim("batch")!;
    let calls = 0;
    const broker = new WorkerBroker(
      policy,
      f.budget,
      f.jobs,
      new Map([
        [
          "test-model",
          async () => {
            calls++;
            return { requestId: "never", cost: 0, value: null };
          },
        ],
      ]),
    );
    const token = broker.grant({
      principal,
      version: f.registry.get().policyVersion,
      jobId: job.id,
      fence: worker.fence,
      purpose: "model",
      routeId: "test-model",
      sourceIds: ["fixture"],
    });
    f.sessions.revoke(f.token);
    await expect(broker.call(token, "revoked-call", 1)).rejects.toThrow("AUTH");
    expect(calls).toBe(0);
  } finally {
    await f.close();
  }
});
test("timeout retains unknown reservation and accepts a late bill without re-dispatching", async () => {
  const f = await fixture();
  try {
    f.registry.saveSettings(settings, 1);
    const policy = new Policy(f.registry);
    policy.setSource({
      sourceId: "fixture",
      retracted: false,
      routes: Object.fromEntries(
        Purpose.options.map((p) => [p, p === "model" ? ["test-model"] : []]),
      ),
    });
    const principal = f.sessions.refresh(f.token);
    const job = f.jobs.enqueue(
      {
        operationKey: "timeout-broker",
        queue: "batch",
        kind: "diagnostic-check",
      },
      100,
    );
    const worker = f.jobs.claim("batch")!;
    let finish!: (result: {
      requestId: string;
      cost: number;
      value: unknown;
    }) => void;
    const broker = new WorkerBroker(
      policy,
      f.budget,
      f.jobs,
      new Map([
        [
          "test-model",
          () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        ],
      ]),
    );
    const token = broker.grant({
      principal,
      version: f.registry.get().policyVersion,
      jobId: job.id,
      fence: worker.fence,
      purpose: "model",
      routeId: "test-model",
      sourceIds: ["fixture"],
    });
    await expect(
      broker.call(token, "timeout-call", 1, AbortSignal.timeout(5)),
    ).rejects.toThrow("UNKNOWN_COST");
    const call = f.store.db.prepare("SELECT id,state FROM calls").get() as {
      id: string;
      state: string;
    };
    expect(call.state).toBe("unknown");
    await expect(broker.call(token, "timeout-call", 1)).rejects.toThrow(
      "CALL_ALREADY_SENT",
    );
    finish({ requestId: "late-bill", cost: 55, value: null });
    await new Promise((r) => setTimeout(r, 0));
    expect(f.budget.get(call.id).actual).toBe(55);
  } finally {
    await f.close();
  }
});
