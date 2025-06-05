import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as semver from 'semver';
import { fileURLToPath } from 'node:url';
import { logger } from '@elizaos/core';
import { existsSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolveEnvFile } from './resolve-utils';
import { emoji } from './emoji-handler';

// Types
interface OSInfo {
  platform: string;
  release: string;
  arch: string;
  type: string;
  version: string;
  homedir: string;
}

interface CLIInfo {
  version: string;
  name: string;
  path: string;
}

interface PackageManagerInfo {
  name: 'bun';
  version: string | null;
  global: boolean;
  isNpx: boolean;
  isBunx: boolean;
}

interface PathInfo {
  elizaDir: string;
  envFilePath: string;
  configPath: string;
  pluginsDir: string;
  monorepoRoot: string | null;
  packageJsonPath: string;
}

interface EnvInfo {
  GITHUB_USERNAME?: string;
  GITHUB_TOKEN?: string;
  [key: string]: string | undefined;
}

export interface UserEnvironmentInfo {
  os: OSInfo;
  cli: CLIInfo;
  packageManager: PackageManagerInfo;
  timestamp: string;
  paths: PathInfo;
  env: EnvInfo;
}

/**
 * Provides information about the user's environment including OS, CLI, and package manager details.
 * Uses singleton pattern to cache results.
 */
export class UserEnvironment {
  public static readonly getInstance = () => UserEnvironment.instance;

  public static readonly getInstanceInfo = () => UserEnvironment.instance.getInfo();

  private static readonly instance: UserEnvironment = new UserEnvironment();
  private cachedInfo: { [key: string]: UserEnvironmentInfo } = {}; // Cache per directory

  private constructor() {}

  /**
   * Gets operating system information
   */
  private async getOSInfo(): Promise<OSInfo> {
    logger.debug('[UserEnvironment] Detecting OS information');
    return {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      type: os.type(),
      version: os.version(),
      homedir: os.homedir(),
    };
  }

  /**
   * Gets CLI version and package information
   */
  private async getCLIInfo(): Promise<CLIInfo> {
    logger.debug('[UserEnvironment] Getting CLI information');
    try {
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = path.dirname(__filename);
      const packageJsonPath = path.resolve(__dirname, '../package.json');

      if (!existsSync(packageJsonPath)) {
        throw new Error(`CLI package.json not found at ${packageJsonPath}`);
      }

      const packageJsonContent = await fs.readFile(packageJsonPath, 'utf-8');
      const packageJson = JSON.parse(packageJsonContent);

      return {
        version: packageJson.version || '0.0.0',
        name: packageJson.name || '@elizaos/cli',
        path: process.argv[1] || '',
      };
    } catch (error) {
      logger.warn(
        `[UserEnvironment] Error getting CLI info: ${error instanceof Error ? error.message : String(error)}`
      );
      return {
        version: '0.0.0',
        name: '@elizaos/cli',
        path: process.argv[1] || '',
      };
    }
  }

  /**
   * Detects the active package manager - always returns bun for ElizaOS CLI
   * @param directory Optional directory to check for lock files. Defaults to process.cwd().
   */
  private async getPackageManagerInfo(directory?: string): Promise<PackageManagerInfo> {
    logger.debug('[UserEnvironment] Using bun as the package manager for ElizaOS CLI');

    const isNpx = process.env.npm_execpath?.includes('npx');
    const isBunx = process.argv[0]?.includes('bun');

    let version: string | null = null;

    try {
      // Get bun version
      const { stdout } = await import('execa').then(({ execa }) => execa('bun', ['--version']));
      version = stdout.trim();
      logger.debug(`[UserEnvironment] Bun version: ${version}`);
    } catch (e) {
      logger.error(
        `[UserEnvironment] Could not get bun version: ${e instanceof Error ? e.message : String(e)}`
      );

      // Enhanced bun installation guidance
      const platform = process.platform;
      logger.error(
        `${emoji.error('Bun is required for ElizaOS CLI but is not installed or not found in PATH.')}`
      );
      logger.error('');
      logger.error(`${emoji.rocket('Install Bun using the appropriate command for your system:')}`);
      logger.error('');

      if (platform === 'win32') {
        logger.error('   Windows: powershell -c "irm bun.sh/install.ps1 | iex"');
      } else {
        logger.error('   Linux/macOS: curl -fsSL https://bun.sh/install | bash');
        if (platform === 'darwin') {
          logger.error('   macOS (Homebrew): brew install bun');
        }
      }
      logger.error('');
      logger.error('   More options: https://bun.sh/docs/installation');
      logger.error('   After installation, restart your terminal or source your shell profile');
      logger.error('');

      // Force exit the process - Bun is required for ElizaOS CLI
      logger.error('🔴 Exiting: Bun installation is required to continue.');
      process.exit(1);
    }

    const packageName = '@elizaos/cli';
    let isGlobalCheck = false;
    try {
      // Check if running via npx/bunx first, as these might trigger global check falsely
      if (!isNpx && !isBunx) {
        // Check if bun has the CLI installed globally
        execSync(`bun pm ls -g | grep -q "${packageName}"`, { stdio: 'ignore' });
        isGlobalCheck = true;
      }
    } catch (error) {
      // Package not found globally
      isGlobalCheck = false;
    }

    // Combine check with NODE_ENV check
    const isGlobal = isGlobalCheck || process.env.NODE_ENV === 'global';

    return {
      name: 'bun',
      version,
      global: isGlobal,
      isNpx,
      isBunx,
    };
  }

  /**
   * Finds the monorepo root by traversing upwards from a starting directory,
   * looking for a marker directory ('packages/core').
   *
   * @param startDir The directory to start searching from.
   * @returns The path to the monorepo root if found, otherwise null.
   */
  private findMonorepoRoot(startDir: string): string | null {
    let currentDir = path.resolve(startDir);
    while (true) {
      const corePackagePath = path.join(currentDir, 'packages', 'core');
      if (existsSync(corePackagePath)) {
        // Check if 'packages/core' itself exists and is a directory
        try {
          const stats = statSync(corePackagePath);
          if (stats.isDirectory()) {
            return currentDir; // Found the root containing 'packages/core'
          }
        } catch (e) {
          // Ignore errors like permission denied, continue search
        }
      }

      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) {
        // Reached the filesystem root
        return null;
      }
      currentDir = parentDir;
    }
  }

  public async getPathInfo(): Promise<PathInfo> {
    const monorepoRoot = this.findMonorepoRoot(process.cwd());
    const projectRootForPaths = monorepoRoot || process.cwd();
    const elizaDir = path.join(projectRootForPaths, '.eliza');

    // Resolve .env from current working directory up to monorepo root (if any), or only cwd if not in monorepo
    const envFilePath = resolveEnvFile(process.cwd(), monorepoRoot ?? undefined);

    logger.debug('[UserEnvironment] Detected monorepo root:', monorepoRoot || 'Not in monorepo');

    return {
      elizaDir,
      envFilePath,
      configPath: path.join(elizaDir, 'config.json'),
      pluginsDir: path.join(elizaDir, 'plugins'),
      monorepoRoot,
      packageJsonPath: path.join(projectRootForPaths, 'package.json'),
    };
  }

  private async getEnvInfo(): Promise<EnvInfo> {
    // Return a copy of process.env as EnvInfo
    return { ...process.env } as EnvInfo;
  }

  public async getInfo(directory?: string): Promise<UserEnvironmentInfo> {
    const cacheKey = directory || 'cwd'; // Use directory or 'cwd' as cache key

    if (this.cachedInfo[cacheKey]) {
      return this.cachedInfo[cacheKey];
    }

    logger.debug(`[UserEnvironment] Gathering environment information for directory: ${cacheKey}`);

    const [os, cli, packageManager, paths, env] = await Promise.all([
      this.getOSInfo(),
      this.getCLIInfo(),
      this.getPackageManagerInfo(directory), // Pass directory here
      this.getPathInfo(),
      this.getEnvInfo(),
    ]);

    const info = {
      os,
      cli,
      packageManager,
      timestamp: new Date().toISOString(),
      paths,
      env,
    };

    this.cachedInfo[cacheKey] = info; // Store info using cache key

    return info;
  }

  /**
   * Clears the cached information
   */
  public clearCache(): void {
    this.cachedInfo = {};
  }

  /**
   * Gets the version of a specified package from monorepo, local dependencies, or npm
   */
  public async getPackageVersion(packageName: string): Promise<string> {
    try {
      const { monorepoRoot } = await this.getPathInfo();

      // Try monorepo first if available
      if (monorepoRoot) {
        const monoRepoPackagePath = path.join(
          monorepoRoot,
          'packages',
          packageName.replace('@elizaos/', ''),
          'package.json'
        );

        if (existsSync(monoRepoPackagePath)) {
          const packageJson = JSON.parse(await fs.readFile(monoRepoPackagePath, 'utf8'));
          if (packageJson.version) return packageJson.version;
        }
      }

      // Check CLI package dependencies
      const cliInfo = await this.getCLIInfo();
      const cliDir = path.dirname(cliInfo.path);
      const cliPackagePath = path.join(cliDir, 'package.json');

      if (existsSync(cliPackagePath)) {
        const packageJson = JSON.parse(await fs.readFile(cliPackagePath, 'utf8'));
        const versionRange = packageJson.dependencies?.[packageName];
        if (versionRange) {
          const minVer = semver.minVersion(versionRange);
          if (minVer) {
            return minVer.version; // Use the parsed minimum version
          } else {
            logger.warn(
              `Could not parse semver range '${versionRange}' for package ${packageName}. Falling back to original string.`
            );
            return versionRange; // Fallback to original string if parsing fails
          }
        }
      }

      // Try npm as last resort
      try {
        const { execa } = await import('execa');
        const { stdout } = await execa('npm', ['view', packageName, 'version']);
        if (stdout?.trim()) {
          logger.info(`Found latest version of ${packageName} from npm: ${stdout.trim()}`);
          return stdout.trim();
        }
      } catch (npmError) {
        logger.warn(`Could not get latest version from npm: ${npmError}`);
      }

      return '0.25.9'; // Default fallback
    } catch (error) {
      logger.warn(`Error getting package version for ${packageName}: ${error}`);
      return '0.25.9';
    }
  }

  /**
   * Get local packages available in the monorepo
   */
  public async getLocalPackages(): Promise<string[]> {
    const { monorepoRoot } = await this.getPathInfo();
    if (!monorepoRoot) return [];

    try {
      const packagesDirEntries = await fs.readdir(path.join(monorepoRoot, 'packages'), {
        withFileTypes: true,
      });

      const pluginPackages = packagesDirEntries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('plugin-'))
        .map((entry) => `@elizaos/${entry.name}`);

      return pluginPackages;
    } catch (error) {
      logger.warn(`Error getting local packages: ${error}`);
      return [];
    }
  }
}
