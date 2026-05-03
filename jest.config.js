/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.test.ts'],
  // Run serially to avoid SIGKILL from resource contention between SQLite-heavy suites
  maxWorkers: 1,
  globals: {
    'ts-jest': {
      tsconfig: {
        // Override rootDir so ts-jest can compile files outside src/
        rootDir: '.',
      },
    },
  },
};
