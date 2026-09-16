export interface ReadOnlyNavigationResult {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated: boolean;
}

export interface ReadOnlyNavigation {
  run(
    scopePath: string,
    command: string,
    signal?: AbortSignal,
  ): Promise<ReadOnlyNavigationResult>;
}

export interface ReadOnlyNavigationBinding {
  runner: ReadOnlyNavigation;
  scopePath: string;
}
