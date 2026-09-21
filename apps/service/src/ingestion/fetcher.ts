import type { AcquisitionPlan } from "@kb/contracts";
import { fetchResponse } from "../security/egress";
import { AppError } from "../errors";
export function normalizeUrl(input: string) {
  const url = new URL(input);
  url.hash = "";
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443")
  )
    throw new AppError("FORBIDDEN", 403);
  return url.href;
}
export function withinScope(url: URL, plan: AcquisitionPlan) {
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return false;
  }
  if (path.includes("\\") || path.split("/").includes("..")) return false;
  return (
    plan.allowedHosts.includes(url.hostname) &&
    plan.allowedPaths.some(
      (prefix) =>
        prefix === "/" ||
        path === prefix ||
        path.startsWith(prefix.endsWith("/") ? prefix : prefix + "/"),
    )
  );
}
export function fetchScoped(
  input: string,
  plan: AcquisitionPlan,
  signal?: AbortSignal,
  remaining = plan.maxBytes,
) {
  return fetchResponse(
    normalizeUrl(input),
    plan.allowedHosts,
    signal,
    Math.min(20_000_000, remaining),
    (url) => withinScope(url, plan),
  );
}
