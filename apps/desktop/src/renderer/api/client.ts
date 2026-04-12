export type ApiErrorCode = "NETWORK_ERROR" | "BAD_RESPONSE" | "TIMEOUT" | "BACKEND_ERROR";

export interface ApiErrorDetails {
  status?: number;
  backendMessage?: string;
  cause?: unknown;
}

export class ApiError extends Error {
  public readonly code: ApiErrorCode;
  public readonly details: ApiErrorDetails;

  constructor(code: ApiErrorCode, message: string, details: ApiErrorDetails = {}) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.details = details;
  }
}

export interface ApiClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  getToken?: () => string | null;
}

export interface RequestOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const AUTH_TOKEN_KEY = "autoapply_token";

function getDefaultToken(): string | null {
  return localStorage.getItem(AUTH_TOKEN_KEY);
}

async function parseJsonSafe(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly getToken: () => string | null;

  constructor(options: ApiClientOptions = {}) {
    const envBaseUrl = window.desktopApi?.apiBaseUrl ?? "http://localhost:4000";
    this.baseUrl = options.baseUrl ?? envBaseUrl;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.getToken = options.getToken ?? getDefaultToken;
  }

  public async get<TResponse>(path: string, options?: RequestOptions): Promise<TResponse> {
    return this.request<TResponse>("GET", path, undefined, options);
  }

  public async post<TRequest, TResponse>(
    path: string,
    body?: TRequest,
    options?: RequestOptions
  ): Promise<TResponse> {
    return this.request<TResponse>("POST", path, body, options);
  }

  private async request<TResponse>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    options?: RequestOptions
  ): Promise<TResponse> {
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;
    const url = `${this.baseUrl}${path}`;

    const timeoutController = new AbortController();
    const timeoutId = window.setTimeout(() => {
      timeoutController.abort(new DOMException("Request timed out", "TimeoutError"));
    }, timeoutMs);

    const signal = options?.signal
      ? AbortSignal.any([timeoutController.signal, options.signal])
      : timeoutController.signal;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...options?.headers
    };

    const token = this.getToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal
      });

      const payload = await parseJsonSafe(response);

      if (!response.ok) {
        const backendMessage = this.extractBackendMessage(payload);
        throw new ApiError(
          response.status >= 500 || backendMessage ? "BACKEND_ERROR" : "BAD_RESPONSE",
          backendMessage ?? `Request failed with status ${response.status}`,
          { status: response.status, backendMessage }
        );
      }

      if (payload === null) {
        throw new ApiError("BAD_RESPONSE", "Expected JSON response but none was returned", {
          status: response.status
        });
      }

      return payload as TResponse;
    } catch (error: unknown) {
      if (error instanceof ApiError) {
        throw error;
      }

      if (error instanceof DOMException && error.name === "AbortError") {
        throw new ApiError("TIMEOUT", `Request timed out after ${timeoutMs} ms`, { cause: error });
      }

      throw new ApiError("NETWORK_ERROR", "Network error while calling backend", { cause: error });
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  private extractBackendMessage(payload: unknown): string | undefined {
    if (payload && typeof payload === "object") {
      const value = payload as { message?: unknown; error?: unknown };
      if (typeof value.message === "string" && value.message.trim().length > 0) return value.message;
      if (typeof value.error === "string" && value.error.trim().length > 0) return value.error;
    }
    return undefined;
  }
}

export const apiClient = new ApiClient();
