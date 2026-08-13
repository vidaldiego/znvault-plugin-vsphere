// Path: src/plugin-types.ts
// Mirror of znvault-cli's CLIPlugin/CLIPluginContext contract (structural
// typing — this package has no compile-time dependency on znvault-cli's
// concrete types, only on the shape the plugin host actually calls).
// Pattern: znvault-plugin-webdeploy's src/cli/plugin-types.ts.

import type { Command } from 'commander';

export interface CLIPluginContext {
  client: {
    get<T>(path: string): Promise<T>;
    post<T>(path: string, body: unknown): Promise<T>;
  };
  output: {
    success(message: string): void;
    error(message: string): void;
    warn(message: string): void;
    info(message: string): void;
  };
  getConfig(): { url: string };
  isPlainMode(): boolean;
}

export interface CLIPlugin {
  name: string;
  version: string;
  description?: string;
  registerCommands(program: Command, ctx: CLIPluginContext): void;
}
