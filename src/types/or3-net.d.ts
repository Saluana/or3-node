declare module "or3-net" {
  export interface NodeManifest {
    readonly node_id: string;
    readonly pubkey: string;
    readonly adapter_kind: string;
    readonly capabilities: readonly string[];
    readonly isolation_class: string;
    readonly supports_transports: readonly string[];
    readonly resource_limits: {
      readonly max_concurrent_jobs: number;
      readonly cpu_cores: number;
      readonly memory_mb: number;
      readonly disk_mb: number;
    };
    readonly lease_policy: {
      readonly max_ttl_seconds: number;
      readonly supports_warm_pool: boolean;
      readonly reset_methods: readonly string[];
    };
    readonly version: string;
    readonly signature: string;
  }

  export interface TaskPackage {
    readonly workspace_id: string;
    readonly job_id: string;
    readonly kind: string;
    readonly instructions: string;
    readonly artifacts: readonly unknown[];
    readonly timeout: {
      readonly hard_ms?: number;
      readonly soft_ms?: number;
    };
    readonly metadata: Record<string, unknown> & {
      readonly command?: unknown;
      readonly args?: unknown;
      readonly env?: unknown;
      readonly cwd?: unknown;
      readonly stdin?: unknown;
      readonly session_id?: unknown;
    };
  }

  interface RequestBase<TMethod extends string, TParams> {
    readonly id: string;
    readonly method: TMethod;
    readonly params: TParams;
  }

  export type NodeRequest =
    | RequestBase<"heartbeat", Record<string, never>>
    | RequestBase<"abort", { readonly job_id: string }>
    | RequestBase<"execute", TaskPackage>
    | RequestBase<"handshake", Record<string, never>>
    | RequestBase<"create_session", { readonly session_id: string; readonly workspace_id: string }>
    | RequestBase<"get_session", { readonly session_id: string }>
    | RequestBase<"destroy_session", { readonly session_id: string }>
    | RequestBase<
        "session_exec",
        {
          readonly session_id: string;
          readonly command: string;
          readonly args?: string[];
          readonly cwd?: string;
          readonly env?: Record<string, string>;
          readonly timeout_ms?: number;
          readonly stdin?: string;
        }
      >
    | RequestBase<"get_logs", { readonly session_id: string; readonly cursor?: string; readonly limit?: number }>
    | RequestBase<"file_read", { readonly path: string; readonly encoding?: "text" | "base64" }>
    | RequestBase<
        "file_write",
        {
          readonly path: string;
          readonly content_text?: string;
          readonly content_base64?: string;
          readonly overwrite?: boolean;
        }
      >
    | RequestBase<"file_delete", { readonly path: string; readonly recursive?: boolean }>
    | RequestBase<"file_browse", { readonly path?: string; readonly recursive?: boolean }>
    | RequestBase<
        "pty_open",
        {
          readonly session_id: string;
          readonly cols?: number;
          readonly rows?: number;
          readonly command?: string;
          readonly args?: string[];
          readonly env?: Record<string, string>;
          readonly cwd?: string;
        }
      >
    | RequestBase<"pty_input", { readonly pty_id: string; readonly data: string }>
    | RequestBase<"pty_resize", { readonly pty_id: string; readonly cols: number; readonly rows: number }>
    | RequestBase<"pty_close", { readonly pty_id: string }>
    | RequestBase<
        "service_launch",
        {
          readonly service_name: string;
          readonly command: string;
          readonly args?: string[];
          readonly port: number;
          readonly env?: Record<string, string>;
          readonly cwd?: string;
        }
      >
    | RequestBase<"service_stop", { readonly service_id: string }>;

  export type NodeTransportFrame =
    | {
        readonly type: "request";
        readonly payload: NodeRequest;
      }
    | {
        readonly type: string;
        readonly payload?: unknown;
      };

  export const nodeTransportFrameSchema: {
    parse(input: unknown): NodeTransportFrame;
  };

  export const signNodeManifest: (
    manifest: Omit<NodeManifest, "signature">,
    secretKey: Uint8Array,
  ) => string;

  export const createId: (prefix: string) => string;
}
