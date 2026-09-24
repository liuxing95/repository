import { lookup } from "node:dns/promises";
import { request } from "node:https";
import ipaddr from "ipaddr.js";
import { AppError } from "../errors";

type Address = { address: string; family: number };
export function publicAddress(address: string) {
  try {
    const parsed = ipaddr.process(address);
    return parsed.range() === "unicast";
  } catch {
    return false;
  }
}
export async function validateTarget(
  input: string,
  hosts: readonly string[],
  resolve = (host: string): Promise<Address[]> => lookup(host, { all: true }),
) {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new AppError("FORBIDDEN", 403);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !hosts.includes(url.hostname) ||
    url.hash
  )
    throw new AppError("FORBIDDEN", 403);
  const addresses = await resolve(url.hostname);
  if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
    throw new AppError("FORBIDDEN", 403);
  return { url, address: addresses[0]! };
}
// The validated IP is pinned in lookup; a second DNS lookup cannot rebind the connection.
export async function fetchResponse(
  input: string,
  hosts: readonly string[],
  signal?: AbortSignal,
  maxBytes = 2_000_000,
  checkPath: (url: URL) => boolean = () => true,
): Promise<{ body: Buffer; finalUrl: string; contentType: string }> {
  let current = input;
  for (let hop = 0; hop < 4; hop++) {
    const { url, address } = await validateTarget(current, hosts);
    if (!checkPath(url)) throw new AppError("FORBIDDEN", 403);
    const response = await new Promise<{
      code: number;
      location?: string;
      body: Buffer;
      contentType: string;
    }>((resolve, reject) => {
      const timeout = AbortSignal.timeout(10_000);
      const req = request(
        url,
        {
          method: "GET",
          agent: false,
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          lookup: (_hostname, options, callback) => {
            // Node can request an array when autoSelectFamily is enabled.
            if (typeof options === "object" && options.all)
              callback(null, [address]);
            else callback(null, address.address, address.family);
          },
          headers: {
            accept: "text/plain, text/html, application/json",
            "user-agent": "KnowledgeTaskCenter/0.1",
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) res.destroy(new AppError("FETCH_LIMIT"));
            else chunks.push(chunk);
          });
          res.on("error", reject);
          res.on("end", () =>
            resolve({
              code: res.statusCode ?? 0,
              location: res.headers.location,
              body: Buffer.concat(chunks),
              contentType: res.headers["content-type"] ?? "",
            }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    });
    if (
      [301, 302, 303, 307, 308].includes(response.code) &&
      response.location
    ) {
      current = new URL(response.location, current).href;
      continue;
    }
    if (response.code < 200 || response.code >= 300)
      throw new AppError("FETCH_FAILED", 502);
    return {
      body: response.body,
      finalUrl: current,
      contentType: response.contentType,
    };
  }
  throw new AppError("REDIRECT_LIMIT", 502);
}

export async function fetchPublic(
  input: string,
  hosts: readonly string[],
  signal?: AbortSignal,
) {
  return (await fetchResponse(input, hosts, signal)).body;
}
