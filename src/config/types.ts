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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

const readString = (value: unknown): string | null => (typeof value === "string" ? value : null);

const readStringArray = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

export const DEFAULT_NODE_AGENT_CONFIG: NodeAgentConfig = {
  controlPlaneUrl: "http://127.0.0.1:3001",
  bootstrapToken: null,
  nodeName: null,
  allowedRoots: [],
  allowedEnvNames: [],
};

export const DEFAULT_NODE_AGENT_STATE: NodeAgentState = {
  nodeId: null,
  enrolledAt: null,
  approvedAt: null,
  credential: {
    token: null,
    expiresAt: null,
  },
};

export const normalizeNodeAgentConfig = (value: unknown): NodeAgentConfig => {
  if (!isRecord(value)) {
    return DEFAULT_NODE_AGENT_CONFIG;
  }

  return {
    controlPlaneUrl: readString(value.controlPlaneUrl) ?? DEFAULT_NODE_AGENT_CONFIG.controlPlaneUrl,
    bootstrapToken: readString(value.bootstrapToken),
    nodeName: readString(value.nodeName),
    allowedRoots: readStringArray(value.allowedRoots),
    allowedEnvNames: readStringArray(value.allowedEnvNames),
  };
};

export const normalizeNodeAgentState = (value: unknown): NodeAgentState => {
  if (!isRecord(value)) {
    return DEFAULT_NODE_AGENT_STATE;
  }

  const credentialValue = isRecord(value.credential) ? value.credential : null;
  return {
    nodeId: readString(value.nodeId),
    enrolledAt: readString(value.enrolledAt),
    approvedAt: readString(value.approvedAt),
    credential: {
      token: readString(credentialValue?.token),
      expiresAt: readString(credentialValue?.expiresAt),
    },
  };
};
