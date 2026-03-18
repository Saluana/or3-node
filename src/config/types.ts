export interface NodeAgentConfig {
  readonly controlPlaneUrl: string;
  readonly bootstrapToken: string | null;
  readonly nodeName: string | null;
  readonly allowedRoots: readonly string[];
  readonly allowedEnvNames: readonly string[];
}

export interface NodeAgentState {
  readonly nodeId: string | null;
  readonly enrolledAt: string | null;
  readonly approvedAt: string | null;
  readonly credential: {
    readonly token: string | null;
    readonly expiresAt: string | null;
  };
}

export interface LaunchCommandOptions {
  controlPlaneUrl?: string;
  bootstrapToken?: string;
  nodeName?: string;
  foreground: boolean;
  interactive: boolean;
}
