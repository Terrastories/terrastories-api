import { FastifyInstance } from 'fastify';
import { LightMyRequestResponse } from 'light-my-request';

export interface ApiClientConfig {
  typescriptBaseUrl: string;
  railsBaseUrl: string;
  app: FastifyInstance;
}

export interface ApiResponse<T = unknown> {
  statusCode: number;
  body: T;
  headers: Record<string, string | string[]>;
}

export interface ComparisonResult {
  match: boolean;
  rails: ApiResponse;
  typescript: ApiResponse;
  differences?: string[];
  metrics?: {
    railsResponseTime: number;
    typescriptResponseTime: number;
  };
}

export interface RequestOptions {
  auth?: string;
  data?: Record<string, unknown> | string;
  headers?: Record<string, string>;
}

/**
 * Dual API Client for comparing Rails and TypeScript API responses
 */
export class DualApiClient {
  constructor(private config: ApiClientConfig) {}

  /**
   * Compare endpoint responses between Rails and TypeScript APIs
   */
  async compareEndpoint(
    method: string,
    endpoint: string,
    options: RequestOptions = {}
  ): Promise<ComparisonResult> {
    const [typescriptResponse, railsResponse] = await Promise.all([
      this.makeTypescriptRequest(method, endpoint, options),
      this.isRailsApiAvailable().then((available) =>
        available
          ? this.makeRailsRequest(method, endpoint, options)
          : this.getMockRailsResponse(method, endpoint, options)
      ),
    ]);

    const differ = await import('./response-differ');
    const responseDiffer = new differ.ResponseDiffer();

    // Cache Rails response data to avoid double consumption
    const railsStatus = railsResponse.status || railsResponse.statusCode;
    const railsHeaders = railsResponse.headers;
    const railsRawBody =
      typeof railsResponse.text === 'function'
        ? await railsResponse.text()
        : railsResponse.body;

    // Try to parse JSON for stable comparison
    const railsBody = (() => {
      try {
        return typeof railsRawBody === 'string'
          ? JSON.parse(railsRawBody)
          : railsRawBody;
      } catch {
        return railsRawBody;
      }
    })();

    const comparison = responseDiffer.compareResponses(
      {
        statusCode: railsStatus,
        body: railsBody,
        headers: railsHeaders,
      },
      {
        statusCode: typescriptResponse.statusCode,
        body: typescriptResponse.body,
        headers: typescriptResponse.headers,
      }
    );

    return {
      match: comparison.match,
      rails: {
        statusCode: railsStatus,
        body: railsBody,
        headers: railsHeaders,
      },
      typescript: {
        statusCode: typescriptResponse.statusCode,
        body: typescriptResponse.body,
        headers: typescriptResponse.headers,
      },
      differences: comparison.differences,
    };
  }

  /**
   * Compare endpoint with performance metrics
   */
  async compareEndpointWithMetrics(
    method: string,
    endpoint: string,
    options: RequestOptions = {}
  ): Promise<ComparisonResult> {
    const typescriptStart = Date.now();
    const typescriptResponse = await this.makeTypescriptRequest(
      method,
      endpoint,
      options
    );
    const typescriptTime = Date.now() - typescriptStart;

    const railsStart = Date.now();
    const railsResponse = await this.isRailsApiAvailable().then((available) =>
      available
        ? this.makeRailsRequest(method, endpoint, options)
        : this.getMockRailsResponse(method, endpoint, options)
    );
    const railsTime = Date.now() - railsStart;

    // Use existing responses instead of making duplicate calls
    const differ = await import('./response-differ');
    const responseDiffer = new differ.ResponseDiffer();

    // Cache Rails response data to avoid double consumption
    const railsStatus = railsResponse.status || railsResponse.statusCode;
    const railsHeaders = railsResponse.headers;
    const railsRawBody =
      typeof railsResponse.text === 'function'
        ? await railsResponse.text()
        : railsResponse.body;

    // Try to parse JSON for stable comparison
    const railsBody = (() => {
      try {
        return typeof railsRawBody === 'string'
          ? JSON.parse(railsRawBody)
          : railsRawBody;
      } catch {
        return railsRawBody;
      }
    })();

    const comparison = responseDiffer.compareResponses(
      {
        statusCode: railsStatus,
        body: railsBody,
        headers: railsHeaders,
      },
      {
        statusCode: typescriptResponse.statusCode,
        body: typescriptResponse.body,
        headers: typescriptResponse.headers,
      }
    );

    return {
      match: comparison.match,
      rails: {
        statusCode: railsStatus,
        body: railsBody,
        headers: railsHeaders,
      },
      typescript: {
        statusCode: typescriptResponse.statusCode,
        body: typescriptResponse.body,
        headers: typescriptResponse.headers,
      },
      differences: comparison.differences,
      metrics: {
        railsResponseTime: railsTime,
        typescriptResponseTime: typescriptTime,
      },
    };
  }

  /**
   * Make request to TypeScript API
   */
  private async makeTypescriptRequest(
    method: string,
    endpoint: string,
    options: RequestOptions = {}
  ): Promise<LightMyRequestResponse> {
    const requestOptions = {
      method: method.toUpperCase() as 'GET' | 'POST' | 'PUT' | 'DELETE',
      url: endpoint,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    } as any;

    // Add authentication if provided
    if (options.auth) {
      requestOptions.headers.cookie = `sessionId=${options.auth}`;
    }

    // Add request body for POST/PUT requests
    if (
      options.data &&
      ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase())
    ) {
      requestOptions.payload = JSON.stringify(options.data);
    }

    // Add query parameters for GET requests
    if (options.data && method.toUpperCase() === 'GET') {
      const params = new URLSearchParams(options.data);
      requestOptions.url = `${endpoint}${endpoint.includes('?') ? '&' : '?'}${params.toString()}`;
    }

    return this.config.app.inject(requestOptions);
  }

  /**
   * Make request to Rails API
   */
  private async makeRailsRequest(
    method: string,
    endpoint: string,
    options: RequestOptions = {}
  ): Promise<Response> {
    const url = `${this.config.railsBaseUrl}${endpoint}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    // Add authentication if provided
    if (options.auth) {
      headers['Cookie'] = `sessionId=${options.auth}`;
    }

    const requestInit: RequestInit = {
      method: method.toUpperCase(),
      headers,
    };

    // Add request body for POST/PUT requests
    if (
      options.data &&
      ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase())
    ) {
      requestInit.body = JSON.stringify(options.data);
    }

    // Handle query parameters for GET requests
    const finalUrl =
      options.data && method.toUpperCase() === 'GET'
        ? `${url}${url.includes('?') ? '&' : '?'}${new URLSearchParams(options.data).toString()}`
        : url;

    return fetch(finalUrl, requestInit);
  }

  /**
   * Check if Rails API is available
   */
  async isRailsApiAvailable(): Promise<boolean> {
    try {
      const healthUrl = `${this.config.railsBaseUrl}/health`;
      const response = await fetch(healthUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(5000), // 5 second timeout
      });
      return response.ok;
    } catch (error) {
      return false;
    }
  }

  /**
   * Use mock Rails responses when Rails API unavailable
   */
  private async getMockRailsResponse(
    method: string,
    endpoint: string,
    options: RequestOptions = {}
  ): Promise<any> {
    // Import mock responses dynamically
    const { RailsMocker } = await import('./rails-mocker');
    const mocker = new RailsMocker();

    return mocker.getMockResponse(method, endpoint, options);
  }
}
