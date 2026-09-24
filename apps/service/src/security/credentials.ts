import { Entry } from "@napi-rs/keyring";
import { AppError } from "../errors";

// The database/config contains only this reference. Never return credentials to a worker.
export class Credentials {
  constructor(private readonly namespace: string) {}
  private entry(reference: string) {
    if (!/^[a-z0-9-]{1,64}$/.test(reference))
      throw new AppError("VALIDATION", 400);
    return new Entry("knowledge-task-center", `${this.namespace}:${reference}`);
  }
  set(reference: string, value: string) {
    this.entry(reference).setPassword(value);
  }
  get(reference: string) {
    const value = this.entry(reference).getPassword();
    if (!value) throw new AppError("CREDENTIALS", 503);
    return value;
  }
  delete(reference: string) {
    return this.entry(reference).deleteCredential();
  }
}
