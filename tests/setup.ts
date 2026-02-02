// Test setup file

// Extend Jest matchers if needed
expect.extend({});

// Global test utilities
beforeEach(() => {
  // Clear all mocks before each test
  jest.clearAllMocks();
});

// Suppress console.error in tests unless explicitly testing error logging
const originalConsoleError = console.error;
beforeAll(() => {
  console.error = jest.fn();
});

afterAll(() => {
  console.error = originalConsoleError;
});

// Helper to restore console.error for specific tests
export function withConsoleError<T>(fn: () => T): T {
  const current = console.error;
  console.error = originalConsoleError;
  try {
    return fn();
  } finally {
    console.error = current;
  }
}

// Export type for tests
export type MockConsoleError = jest.Mock;
export const getConsoleErrorMock = (): MockConsoleError =>
  console.error as jest.Mock;
