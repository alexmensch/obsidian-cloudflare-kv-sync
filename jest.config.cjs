/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "jsdom",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],
  moduleFileExtensions: ["ts", "js"],
  collectCoverage: true,
  collectCoverageFrom: ["main.ts"],
  coveragePathIgnorePatterns: [
    // Exclude the CloudflareKVSettingsTab class (lines 476-636)
    "CloudflareKVSettingsTab"
  ],
  coverageThreshold: {
    global: {
      branches: 90,
      functions: 90,
      lines: 90,
      statements: 90
    }
  },
  setupFilesAfterEnv: ["<rootDir>/tests/setup.ts"],
  moduleNameMapper: {
    "^obsidian$": "<rootDir>/src/__mocks__/obsidian.ts"
  },
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        tsconfig: {
          module: "commonjs",
          esModuleInterop: true,
          skipLibCheck: true
        },
        isolatedModules: true
      }
    ]
  }
};
