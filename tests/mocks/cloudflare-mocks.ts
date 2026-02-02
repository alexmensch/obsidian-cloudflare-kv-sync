// Mock factories for Cloudflare API responses

/**
 * Creates a successful Cloudflare API response
 */
export function mockSuccessResponse(): { text: string } {
  return {
    text: JSON.stringify({ success: true })
  };
}

/**
 * Creates a Cloudflare API error response
 */
export function mockErrorResponse(
  errors: Array<{ code: number; message: string }>
): { text: string } {
  return {
    text: JSON.stringify({
      success: false,
      errors
    })
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
export function mockInvalidJsonResponse(): { text: string } {
  return {
    text: "Not valid JSON"
  };
}

/**
 * Creates an unexpected array response
 */
export function mockArrayResponse(): { text: string } {
  return {
    text: JSON.stringify([{ unexpected: "array" }])
  };
}

/**
 * Creates a mock response with custom data
 */
export function mockCustomResponse(data: unknown): { text: string } {
  return {
    text: JSON.stringify(data)
  };
}
