import type { Vault } from "./vault";
export class CredentialStoreError extends Error {
  constructor() {
    super(
      "Secure storage is unavailable. Unlock the OS credential store and allow Wagate access, then retry. Your saved session has not been reset.",
    );
  }
}
// Keep the underlying OS operation shared even if an individual caller times out.
// OS credential prompts cannot be cancelled safely; retries must not spawn more prompts.
export function createVaultLoader(
  open: () => Promise<Vault>,
  timeoutMs = 12000,
) {
  let pending: Promise<Vault> | undefined;
  return async () => {
    pending ??= open().catch(() => {
      pending = undefined;
      throw new CredentialStoreError();
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new CredentialStoreError()),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
}
