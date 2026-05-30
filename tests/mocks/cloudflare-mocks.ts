// Mock factories for Cloudflare API responses

/**
 * Creates a successful Cloudflare API response
 */
export function mockSuccessResponse(): { status: number; text: string } {
  return {
    status: 200,
    text: JSON.stringify({ success: true })
  };
}

/**
 * Creates a Cloudflare API error response with an HTTP 200 status but a
 * success:false body. This models the rare structured-error case; most real
 * failures (auth, missing key) come back as HTTP 4xx — see
 * mockHttpErrorResponse.
 */
export function mockErrorResponse(
  errors: Array<{ code: number; message: string }>
): { status: number; text: string } {
  return {
    status: 200,
    text: JSON.stringify({
      success: false,
      errors
    })
  };
}

/**
 * Creates a real Cloudflare HTTP error response (status 400+). The production
 * requestUrl throws on these by default; the plugin passes throw:false and
 * inspects the status, so the mock must carry one.
 */
export function mockHttpErrorResponse(
  status: number,
  errors: Array<{ code: number; message: string }> = [
    { code: status, message: `HTTP ${status}` }
  ]
): { status: number; text: string } {
  return {
    status,
    text: JSON.stringify({ success: false, errors })
  };
}

/**
 * Creates an HTTP error response whose body is not JSON (e.g. an HTML error
 * page from an edge proxy), to exercise the non-JSON error path.
 */
export function mockHttpErrorResponseNonJson(status: number): {
  status: number;
  text: string;
} {
  return {
    status,
    text: "<html><body>Bad gateway</body></html>"
  };
}

/**
 * Creates a network error for testing request failures
 */
export function mockNetworkError(message: string = "Network error"): Error {
  return new Error(message);
}

/**
 * Creates an invalid JSON response
 */
export function mockInvalidJsonResponse(): { status: number; text: string } {
  return {
    status: 200,
    text: "Not valid JSON"
  };
}

/**
 * Creates an unexpected array response
 */
export function mockArrayResponse(): { status: number; text: string } {
  return {
    status: 200,
    text: JSON.stringify([{ unexpected: "array" }])
  };
}

/**
 * Creates a mock response with custom data
 */
export function mockCustomResponse(data: unknown): {
  status: number;
  text: string;
} {
  return {
    status: 200,
    text: JSON.stringify(data)
  };
}
