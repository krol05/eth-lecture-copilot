/**
 * The names the lib files share with each other.
 *
 * There is no build step: files are loaded as ordered script tags and reach
 * each other through the global scope. That is deliberate and documented in
 * eslint.config.mjs, but a type checker reads one file at a time and cannot
 * see it, so the shared names are declared here.
 *
 * Only names a lib file *reads* from another belong here. Everything a file
 * defines for itself is inferred from the file.
 */

declare global {
  // lib/providers/reasoning.js, read by lib/providers/adapters.js
  function reasoningOnBody(
    providerId: string,
    modelId: string,
    modelInfo: Record<string, any> | null | undefined,
    level: string
  ): Record<string, any> | null;

  function reasoningOffBody(
    providerId: string,
    modelId: string,
    modelInfo?: Record<string, any> | null
  ): Record<string, any> | null;

  function clampEffort(level: string, efforts?: string[] | null): string;
  function knownNonReasoning(providerId: string, modelId: string): boolean;

  interface Window {
    /** lib/ui-settings.js publishes itself for the pages that load it. */
    UISettings?: Record<string, any>;
  }
}

export {};
