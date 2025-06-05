import { handleError, installPlugin, logHeader } from '@/src/utils';
import { fetchPluginRegistry } from '@/src/utils/plugin-discovery';
import { normalizePluginName } from '@/src/utils/registry';
import { detectDirectoryType, getDirectoryTypeDescription } from '@/src/utils/directory-detection';
import { logger } from '@elizaos/core';
import { Command } from 'commander';
import { execa } from 'execa';
import fs from 'node:fs';
import path from 'node:path';
import { emoji } from '../utils/emoji-handler';

// --- Helper Functions ---

/**
 * Normalizes a plugins input string to a standard format, typically 'plugin-name'.
 * Used primarily for display and generating commands in bunx instructions.
 */
export const normalizePluginNameForDisplay = (pluginInput: string): string => {
  let baseName = pluginInput;

  // Handle scoped formats like "@scope/plugin-name" or "scope/plugin-name"
  if (pluginInput.includes('/')) {
    const parts = pluginInput.split('/');
    baseName = parts[parts.length - 1];
  }
  // Remove potential scope from "@plugin-name" - less common but possible
  else if (pluginInput.startsWith('@')) {
    const parts = pluginInput.split('/'); // Re-split in case it was just "@plugin-name"
    if (parts.length > 1) {
      baseName = parts[1];
    } else {
      // Assume it's like "@something" without a scope/name separator - maybe log a warning?
      // For now, let's just take the part after '@'
      baseName = pluginInput.substring(1);
    }
  }

  // Ensure it starts with 'plugin-' and remove duplicates if necessary
  baseName = baseName.replace(/^plugin-/, ''); // Remove existing prefix first
  return `plugin-${baseName}`; // Add the prefix back
};

/** Finds the actual package name in dependencies based on various input formats. */
export const findPluginPackageName = (
  pluginInput: string,
  allDependencies: Record<string, string>
): string | null => {
  // Normalize the input to a base form (e.g., 'abc' from 'plugin-abc')
  let normalizedBase = pluginInput.startsWith('@')
    ? pluginInput.split('/')[1] || pluginInput
    : pluginInput;
  normalizedBase = normalizedBase.replace(/^plugin-/, ''); // Remove prefix if present

  // Potential package names to check
  const possibleNames = [
    pluginInput, // Check the raw input first
    `@elizaos/plugin-${normalizedBase}`,
    `@elizaos-plugins/plugin-${normalizedBase}`, // Check alternative scope
    `plugin-${normalizedBase}`,
    `@elizaos/${normalizedBase}`, // Might be needed if input was 'plugin-abc' -> base 'abc' -> check '@elizaos/abc'
    `@elizaos-plugins/${normalizedBase}`,
  ];

  for (const name of possibleNames) {
    if (allDependencies[name]) {
      return name; // Return the first matching key found in dependencies
    }
  }

  return null; // Not found
};

/** Helper function to get dependencies from package.json using directory detection */
const getDependenciesFromDirectory = (cwd: string): Record<string, string> | null => {
  const directoryInfo = detectDirectoryType(cwd);

  if (!directoryInfo.hasPackageJson) {
    return null;
  }

  try {
    const packageJsonPath = path.join(cwd, 'package.json');
    const packageJsonContent = fs.readFileSync(packageJsonPath, 'utf-8');
    const packageJson = JSON.parse(packageJsonContent);
    const dependencies = packageJson.dependencies || {};
    const devDependencies = packageJson.devDependencies || {};
    return { ...dependencies, ...devDependencies };
  } catch (error) {
    if (error instanceof SyntaxError) {
      logger.warn(`Could not parse package.json: ${error.message}`);
    } else {
      logger.warn(`Error reading package.json: ${error.message}`);
    }
    return null;
  }
};

// --- End Helper Functions ---

export const plugins = new Command()
  .name('plugins')
  .description('Manage ElizaOS plugins')
  .action(function () {
    // Show help automatically if no subcommand is specified
    this.help({ showGlobals: false });
  });

export const pluginsCommand = plugins
  .command('list')
  .aliases(['l', 'ls'])
  .description('List available plugins to install into the project')
  .option('--all', 'List all plugins from the registry with detailed version info')
  .option('--v0', 'List only v0.x compatible plugins')
  .action(async (opts: { all?: boolean; v0?: boolean }) => {
    try {
      const cachedRegistry = await fetchPluginRegistry();

      if (
        !cachedRegistry ||
        !cachedRegistry.registry ||
        Object.keys(cachedRegistry.registry).length === 0
      ) {
        logger.info('Plugin cache is empty or not found.');
        console.log('\nPlease run "elizaos plugins update" to fetch the latest plugin registry.');
        return;
      }
      let availablePluginsToDisplay: string[] = [];
      const allPlugins = cachedRegistry ? Object.entries(cachedRegistry.registry) : [];
      let displayTitle = 'Available v1.x plugins';

      if (opts.all) {
        displayTitle = 'All plugins in local cache (detailed view)';
        if (allPlugins.length === 0) {
          console.log('No plugins found in the registry.');
        }
        allPlugins.forEach(([name, info]) => {
          console.log(`\nPlugin: ${name}`);
          const repoInfo = info.git?.repo || info.npm?.repo;
          console.log(`  Repository: ${repoInfo || 'N/A'}`);
          console.log(`  v0 Compatible: ${info.supports.v0 ? 'Yes' : 'No'}`);
          if (info.npm?.v0 || info.git?.v0?.version) {
            const ver = info.npm?.v0 || info.git?.v0?.version;
            const branch = info.git?.v0?.branch;
            console.log(`    Version: ${ver || 'N/A'}${branch ? ` (branch: ${branch})` : ''}`);
          }
          console.log(`  v1 Compatible: ${info.supports.v1 ? 'Yes' : 'No'}`);
          if (info.npm?.v1 || info.git?.v1?.version) {
            const ver = info.npm?.v1 || info.git?.v1?.version;
            const branch = info.git?.v1?.branch;
            console.log(`    Version: ${ver || 'N/A'}${branch ? ` (branch: ${branch})` : ''}`);
          }
        });
        console.log('');
        return;
      } else if (opts.v0) {
        displayTitle = 'Available v0.x plugins';
        availablePluginsToDisplay = allPlugins
          .filter(([, info]) => info.supports.v0)
          .map(([name]) => name);
      } else {
        // Default to v1.x
        availablePluginsToDisplay = allPlugins
          .filter(([, info]) => info.supports.v1)
          .map(([name]) => name);
      }

      logHeader(displayTitle);
      if (availablePluginsToDisplay.length === 0) {
        console.log('No plugins found matching the criteria in the registry.');
      } else {
        for (const pluginName of availablePluginsToDisplay) {
          console.log(`${pluginName}`);
        }
      }
      console.log('');
    } catch (error) {
      handleError(error);
    }
  });

plugins
  .command('add')
  .alias('install')
  .description('Add a plugin to the project')
  .argument('<plugin>', 'plugins name (e.g., "abc", "plugin-abc", "elizaos/plugin-abc")')
  .option('-n, --no-env-prompt', 'Skip prompting for environment variables')
  .option('-b, --branch <branchName>', 'Branch to install from when using monorepo source', 'main')
  .option('-T, --tag <tagname>', 'Specify a tag to install (e.g., beta)')
  .action(async (pluginArg, opts) => {
    const cwd = process.cwd();
    const directoryInfo = detectDirectoryType(cwd);

    if (!directoryInfo.hasPackageJson) {
      logger.error(
        `Command must be run inside an ElizaOS project directory. This directory is: ${getDirectoryTypeDescription(directoryInfo)}`
      );
      process.exit(1);
    }

    const allDependencies = getDependenciesFromDirectory(cwd);
    if (!allDependencies) {
      logger.error('Could not read dependencies from package.json');
      process.exit(1);
    }

    let plugin = pluginArg;

    try {
      // --- Convert full GitHub HTTPS URL to shorthand ---
      const httpsGitHubUrlRegex =
        // eslint-disable-next-line no-useless-escape
        /^https?:\/\/github\.com\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?(?:(?:#|\/tree\/|\/commit\/)([a-zA-Z0-9_.-]+))?\/?$/;
      const httpsMatch = plugin.match(httpsGitHubUrlRegex);

      if (httpsMatch) {
        const [, owner, repo, ref] = httpsMatch;
        plugin = `github:${owner}/${repo}${ref ? `#${ref}` : ''}`;
      }
      // --- End GitHub URL conversion ---

      const installedPluginName = findPluginPackageName(plugin, allDependencies);
      if (installedPluginName) {
        logger.info(`Plugin "${installedPluginName}" is already added to this project.`);
        process.exit(0);
      }

      // --- GitHub Plugin Installation ---
      const githubRegex =
        /^(?:github:)?([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)(?:#([a-zA-Z0-9_.-]+))?$/;
      const githubMatch = plugin.match(githubRegex);

      if (githubMatch) {
        const [, owner, repo, ref] = githubMatch;
        const githubSpecifier = `github:${owner}/${repo}${ref ? `#${ref}` : ''}`;
        // The plugin name for Eliza's internal purposes could be derived from the repo name.
        // For now, we'll use the repo name, but this might need refinement
        // to check package.json inside the repo after installation.
        const pluginNameForPostInstall = repo;

        // For GitHub installs, opts.tag and opts.branch are superseded by the #ref in the specifier.
        // We pass undefined for them to installPlugin, which should be updated to handle this.
        const success = await installPlugin(githubSpecifier, cwd);

        if (success) {
          logger.info(
            `Successfully installed ${pluginNameForPostInstall} from ${githubSpecifier}.`
          );
          // TODO: Add post-installation steps here, similar to other plugin types
          // e.g., prompting for env vars, updating config.
          // For now, just exit cleanly.
          process.exit(0);
        } else {
          logger.error(`Failed to install plugin from ${githubSpecifier}.`);
          process.exit(1);
        }
      } else {
        // --- Registry-based or fuzzy Plugin Installation ---
        const cachedRegistry = await fetchPluginRegistry();
        if (!cachedRegistry || !cachedRegistry.registry) {
          logger.error(
            'Plugin registry cache not found. Please run "elizaos plugins update" first.'
          );
          process.exit(1);
        }

        const possibleNames = normalizePluginName(plugin);
        const pluginKey = possibleNames.find((name) => cachedRegistry.registry[name]);

        const targetName = pluginKey || plugin;

        const registryInstallResult = await installPlugin(targetName, cwd, opts.tag);

        if (registryInstallResult) {
          console.log(`Successfully installed ${targetName}`);
          process.exit(0);
        }

        console.error(`Failed to install ${targetName} from registry.`);
        process.exit(1);
      }
    } catch (error) {
      handleError(error);
    }
  });

plugins
  .command('installed-plugins')
  .description('List plugins found in the project dependencies')
  .action(async () => {
    try {
      const cwd = process.cwd();
      const directoryInfo = detectDirectoryType(cwd);

      if (!directoryInfo.hasPackageJson) {
        console.error(
          `Could not read or parse package.json. This directory is: ${getDirectoryTypeDescription(directoryInfo)}`
        );
        console.info('Please run this command from the root of an ElizaOS project.');
        process.exit(1);
      }

      const allDependencies = getDependenciesFromDirectory(cwd);
      if (!allDependencies) {
        console.error('Could not read dependencies from package.json.');
        process.exit(1);
      }

      const pluginNames = Object.keys(allDependencies).filter((depName) => {
        return /^(@elizaos(-plugins)?\/)?plugin-.+/.test(depName);
      });

      if (pluginNames.length === 0) {
        console.log('No Eliza plugins found in the project dependencies (package.json).');
      } else {
        logHeader('Plugins Added:');
        for (const pluginName of pluginNames) {
          console.log(`${pluginName}`);
        }
        console.log('');
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        console.error(`Error parsing package.json: ${error.message}`);
        process.exit(1);
      }
      handleError(error);
      process.exit(1);
    }
  });

plugins
  .command('remove')
  .aliases(['delete', 'del', 'rm'])
  .description('Remove a plugins from the project')
  .argument('<plugin>', 'plugins name (e.g., "abc", "plugin-abc", "elizaos/plugin-abc")')
  .action(async (plugin, _opts) => {
    try {
      const cwd = process.cwd();
      const directoryInfo = detectDirectoryType(cwd);

      if (!directoryInfo.hasPackageJson) {
        console.error(
          `Could not read or parse package.json. This directory is: ${getDirectoryTypeDescription(directoryInfo)}`
        );
        process.exit(1);
      }

      const allDependencies = getDependenciesFromDirectory(cwd);
      if (!allDependencies) {
        console.error(
          'Could not read dependencies from package.json. Cannot determine which package to remove.'
        );
        process.exit(1);
      }

      const packageNameToRemove = findPluginPackageName(plugin, allDependencies);

      if (!packageNameToRemove) {
        logger.warn(`Plugin matching "${plugin}" not found in project dependencies.`);
        console.info('\nCheck installed plugins using: elizaos project installed-plugins');
        process.exit(0);
      }

      console.info(`Removing ${packageNameToRemove}...`);
      try {
        await execa('bun', ['remove', packageNameToRemove], {
          cwd,
          stdio: 'inherit',
        });
      } catch (execError) {
        logger.error(`Failed to run 'bun remove ${packageNameToRemove}': ${execError.message}`);
        if (execError.stderr?.includes('not found')) {
          logger.info(
            `'bun remove' indicated package was not found. Continuing with directory removal attempt.`
          );
        } else {
          handleError(execError);
          process.exit(1);
        }
      }

      let baseName = packageNameToRemove;
      if (packageNameToRemove.includes('/')) {
        const parts = packageNameToRemove.split('/');
        baseName = parts[parts.length - 1];
      }
      baseName = baseName.replace(/^plugin-/, '');
      const dirNameToRemove = `plugin-${baseName}`;

      const pluginDir = path.join(cwd, dirNameToRemove);
      if (fs.existsSync(pluginDir)) {
        try {
          fs.rmSync(pluginDir, { recursive: true, force: true });
        } catch (rmError) {
          logger.error(`Failed to remove directory ${pluginDir}: ${rmError.message}`);
        }
      } else {
        const nonPrefixedDir = path.join(cwd, baseName);
        if (fs.existsSync(nonPrefixedDir)) {
          try {
            fs.rmSync(nonPrefixedDir, { recursive: true, force: true });
          } catch (rmError) {
            logger.error(`Failed to remove directory ${nonPrefixedDir}: ${rmError.message}`);
          }
        }
      }

      console.log(`Successfully removed ${packageNameToRemove}`);
    } catch (error) {
      handleError(error);
      process.exit(1);
    }
  });

plugins
  .command('upgrade')
  .description('Upgrade a plugin from version 0.x to 1.x using AI-powered migration')
  .argument('<path>', 'GitHub repository URL or local folder path')
  .option('--api-key <key>', 'Anthropic API key (or use ANTHROPIC_API_KEY env var)')
  .option('--skip-tests', 'Skip test validation loop')
  .option('--skip-validation', 'Skip production readiness validation')
  .action(async (pluginPath, opts) => {
    try {
      // Lazy import to avoid loading dependencies until needed
      const { PluginMigrator } = await import('../utils/upgrade/migrator.js');

      // Set API key if provided
      if (opts.apiKey) {
        process.env.ANTHROPIC_API_KEY = opts.apiKey;
      }

      // Check for API key
      if (!process.env.ANTHROPIC_API_KEY) {
        logger.error('ANTHROPIC_API_KEY is required for plugin upgrade.');
        console.log('\nPlease set ANTHROPIC_API_KEY environment variable or use --api-key option.');
        process.exit(1);
      }

      // Create migrator instance with options
      const migrator = new PluginMigrator({
        skipTests: opts.skipTests,
        skipValidation: opts.skipValidation,
      });

      // Run migration
      console.log(`\n${emoji.rocket(`Starting plugin upgrade for: ${pluginPath}`)}\n`);
      const result = await migrator.migrate(pluginPath);

      if (result.success) {
        console.log(`\n${emoji.success('Plugin successfully upgraded!')}`);
        console.log(`   Branch: ${result.branchName}`);
        console.log(`   Location: ${result.repoPath}`);
        console.log(`\nThe upgraded plugin has been copied to your current directory.`);
        console.log(`\nNext steps:`);
        console.log(`1. cd ${path.basename(result.repoPath)}`);
        console.log(`2. Review the changes`);
        console.log(`3. Test the upgraded plugin thoroughly`);
        console.log(`4. Push to GitHub and create a pull request when ready`);
      } else {
        logger.error(`Plugin upgrade failed: ${result.error?.message}`);
        process.exit(1);
      }
    } catch (error) {
      handleError(error);
      process.exit(1);
    }
  });

plugins
  .command('generate')
  .description('Generate a new plugin using AI-powered code generation')
  .option('--api-key <key>', 'Anthropic API key (or use ANTHROPIC_API_KEY env var)')
  .option('--skip-tests', 'Skip test validation loop')
  .option('--skip-validation', 'Skip production readiness validation')
  .option('--skip-prompts', 'Skip interactive prompts (requires --spec-file)')
  .option('--spec-file <path>', 'Path to JSON file containing plugin specification')
  .action(async (opts) => {
    try {
      // Lazy import to avoid loading dependencies until needed
      const { PluginCreator } = await import('../utils/plugin-creator.js');

      // Set API key if provided
      if (opts.apiKey) {
        process.env.ANTHROPIC_API_KEY = opts.apiKey;
      }

      // Check for API key
      if (!process.env.ANTHROPIC_API_KEY) {
        logger.error('ANTHROPIC_API_KEY is required for plugin generation.');
        console.log('\nPlease set ANTHROPIC_API_KEY environment variable or use --api-key option.');
        process.exit(1);
      }

      // Handle spec file if provided
      let spec = undefined;
      if (opts.specFile) {
        try {
          const specContent = fs.readFileSync(opts.specFile, 'utf-8');
          spec = JSON.parse(specContent);
        } catch (error) {
          logger.error(`Failed to read or parse spec file: ${error.message}`);
          process.exit(1);
        }
      } else if (opts.skipPrompts) {
        logger.error('--skip-prompts requires --spec-file to be provided');
        process.exit(1);
      }

      // Create creator instance with options
      const creator = new PluginCreator({
        skipTests: opts.skipTests,
        skipValidation: opts.skipValidation,
        skipPrompts: opts.skipPrompts,
        spec: spec,
      });

      // Run generation
      console.log(`\n${emoji.rocket('Starting AI-powered plugin generation...')}\n`);
      const result = await creator.create();

      if (result.success) {
        console.log(`\n${emoji.success('Plugin successfully generated!')}`);
        console.log(`   Name: ${result.pluginName}`);
        console.log(`   Location: ${result.pluginPath}`);
        console.log(`\nThe plugin has been created in your current directory.`);
        console.log(`\nNext steps:`);
        console.log(`1. cd ${path.basename(result.pluginPath)}`);
        console.log(`2. Review the generated code`);
        console.log(`3. Test the plugin: bun test`);
        console.log(`4. Add to your ElizaOS project`);
      } else {
        logger.error(`Plugin generation failed: ${result.error?.message}`);
        process.exit(1);
      }
    } catch (error) {
      handleError(error);
      process.exit(1);
    }
  });
