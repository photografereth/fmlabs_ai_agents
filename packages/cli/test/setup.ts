import { vi } from 'vitest';
import type { Mock } from 'vitest';

// Global mock for node:fs/promises IS NOW HANDLED by the 'node:fs' mock below

// Global mock for UserEnvironment

// Shared mocks for instance methods
const mockGetInfo = vi.fn();
const mockGetPathInfo = vi.fn();
const mockClearCache = vi.fn();
const mockGetPackageVersion = vi.fn();
const mockGetLocalPackages = vi.fn();

// Define a simple class structure for the mock instance
class MockUserEnvInstance {
  getInfo: Mock;
  getPathInfo: Mock;
  clearCache: Mock;
  getPackageVersion: Mock;
  getLocalPackages: Mock;

  constructor() {
    this.getInfo = mockGetInfo;
    this.getPathInfo = mockGetPathInfo;
    this.clearCache = mockClearCache;
    this.getPackageVersion = mockGetPackageVersion;
    this.getLocalPackages = mockGetLocalPackages;
  }
}

const sharedMockInstance = new MockUserEnvInstance();

// Define the shape of the mock instance that UserEnvironment.getInstance() will return
const userEnvironmentMockSingleton = {
  getInfo: vi.fn(),
  getPathInfo: vi.fn(),
  clearCache: vi.fn(),
  getPackageVersion: vi.fn(),
  getLocalPackages: vi.fn(),
  // Add any other instance methods that need to be available on the mocked singleton
};

vi.mock('../src/utils/user-environment', () => ({
  // Adjusted path assuming setup.ts is in test/
  UserEnvironment: {
    getInstance: vi.fn().mockReturnValue(userEnvironmentMockSingleton),
    getInstanceInfo: vi.fn().mockResolvedValue({
      timestamp: Date.now().toString(),
      os: {
        platform: 'mockOS',
        release: 'mockRelease',
        arch: 'mockArch',
        type: 'mockType',
        version: 'mockVersion',
        homedir: '/mockHome',
      },
      cli: { name: '@elizaos/cli-mock', version: '0.0.0-mock', path: '/mock/path/to/cli' },
      project: {
        name: 'mockProject',
        path: '/mock/project/path',
        remote: { owner: 'mockOwner', repo: 'mockRepo' },
      },
      packageManager: {
        name: 'mockPM',
        version: '1.0-mock',
        global: false,
        isNpx: false,
        isBunx: false,
      },
      paths: {
        elizaDir: '/mock/.eliza',
        envFilePath: '/mock/.env',
        pgliteDbDir: '/mock/.elizadb',
        pluginsDir: '/mock/.eliza/plugins',
        configPath: '/mock/.eliza/config.json',
        packageJsonPath: '/mock/package.json',
      },
      env: { MOCKED_ENV_VAR: 'true' },
    }),
  },
}));

vi.mock('../src/utils/resolve-utils', () => ({
  expandTildePath: vi.fn((p) => p),
  resolveEnvFile: vi.fn().mockReturnValue('/mock/globalDefault.env'), // Consistent global default
  resolvePgliteDir: vi.fn().mockResolvedValue('/mock/.globalDefault-elizadb'),
}));

// Mock for prompts, often used in commands
vi.mock('prompts', () => ({
  default: vi.fn().mockResolvedValue({
    // Provide default keys that might be destructured by any test expecting a prompt
    // Individual tests can override this with mockImplementationOnce or mockResolvedValueOnce
    promptedUsername: 'defaultMockUser',
    promptedToken: 'defaultMockToken',
    type: 'project', // default for create command
    nameResponse: 'defaultMockProject', // default for create command
    database: 'pglite', // default for create command
    postgresUrl: 'postgresql://mock:mock@localhost:5432/mockdb', // for get-config
    // Add other common prompt result keys here as they are identified
  }),
}));

// Mock for @elizaos/core logger
vi.mock('@elizaos/core', async (importOriginal) => {
  const actualCore = await importOriginal<typeof import('@elizaos/core')>();
  return {
    ...actualCore,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
      log: vi.fn(),
      table: vi.fn(),
      spinner: () => ({
        start: vi.fn(),
        stop: vi.fn(),
        succeed: vi.fn(),
        fail: vi.fn(),
        text: '',
      }),
    },
  };
});

// Mock aggregator utils to ensure resolveEnvFile exists before other modules import it
vi.mock('../src/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils')>();
  return {
    ...actual,
    resolveEnvFile: vi.fn().mockReturnValue('/mock/globalDefault.env'),
  };
});
