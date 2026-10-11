import { randomBytes, randomUUID } from "node:crypto";

export function newTransactionId(): string {
  return randomUUID();
}

export function newActionId(): string {
  return randomBytes(9).toString("base64url");
}
