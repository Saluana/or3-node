import type { NodeManifest } from "or3-net";

export type FetchLike = (input: URL | Request | string, init?: RequestInit) => Promise<Response>;

export interface RedeemBootstrapResponse {
  readonly workspace_id: string;
  readonly node: {
    readonly status: string;
    readonly manifest: {
      readonly node_id: string;
    };
    readonly approved_at: string | null;
  };
  readonly credential: {
    readonly token: string;
    readonly expires_at: string;
  } | null;
}

export const redeemBootstrapToken = async (
  baseUrl: string,
  token: string,
  manifest: NodeManifest,
  fetchImpl: FetchLike = fetch,
): Promise<RedeemBootstrapResponse> => {
  const response = await fetchImpl(new URL("/v1/nodes/bootstrap/redeem", baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ token, manifest }),
  });

  if (!response.ok) {
    throw new Error(`bootstrap redeem failed with status ${String(response.status)}`);
  }

  return (await response.json()) as RedeemBootstrapResponse;
};
