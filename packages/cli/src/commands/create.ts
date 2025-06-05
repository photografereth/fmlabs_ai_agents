import { character as elizaCharacter } from '@/src/characters/eliza';
import {
  buildProject,
  copyTemplate as copyTemplateUtil,
  displayBanner,
  ensureElizaDir,
  handleError,
  promptAndStorePostgresUrl,
  promptAndStoreOpenAIKey,
  promptAndStoreAnthropicKey,
  runBunCommand,
  setupPgLite,
} from '@/src/utils';
import { Command } from 'commander';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import prompts from 'prompts';
import colors from 'yoctocolors';
import { z } from 'zod';
import { logger } from '@elizaos/core';
import { join } from 'path';

/**
 * This module handles creating projects, plugins, and agent characters.
 *
 * Previously, plugin creation was handled by the "plugins create" command,
 * but that has been unified with project creation in this single command.
 * Users are now prompted to select which type they want to create.
 *
 * The workflow includes:
 * 1. Asking if the user wants to create a project, plugin, or agent
 * 2. Getting the name and creating a directory or file
 * 3. Setting up proper templates and configurations
 * 4. Installing dependencies (for projects/plugins)
 * 5. Automatically changing directory to the created project/plugin
 * 6. Showing the user the next steps
 */

const initOptionsSchema = z.object({
  dir: z.string().default('.'),
  yes: z.boolean().default(false),
  type: z.enum(['project', 'plugin', 'agent']).default('project'),
  tee: z.boolean().default(false),
});

/**
 * Returns a list of available databases for project initialization without requiring external API calls.
 *
 * @returns A promise that resolves to an array of supported database names.
 */
async function getLocalAvailableDatabases(): Promise<string[]> {
  // Hard-coded list of available databases to avoid GitHub API calls
  return [
    'pglite',
    'postgres',
    // "pglite",
    // "supabase"
  ];
}

/**
 * Gets available AI models for selection during project creation.
 *
 * @returns {Array} Array of available AI model options
 */
function getAvailableAIModels() {
  return [
    {
      title: 'Local AI (free to use, no API key required)',
      value: 'local',
      description:
        'Use local AI models without external API requirements. Will download model to run locally - recommended if you have good internet connection.',
    },
    {
      title: 'OpenAI (ChatGPT)',
      value: 'openai',
      description: 'Use OpenAI models like GPT-4',
    },
    {
      title: 'Anthropic (Claude)',
      value: 'claude',
      description: 'Use Anthropic Claude models',
    },
  ];
}

/**
 * Gets available database options for selection during project creation.
 *
 * @returns {Array} Array of available database options
 */
function getAvailableDatabases() {
  return [
    {
      title: 'Pglite (Pglite) - Recommended for development',
      value: 'pglite',
      description:
        'Fast, file-based database. Perfect for development and single-user deployments.',
    },
    {
      title: 'PostgreSQL - Recommended for production',
      value: 'postgres',
      description:
        'Full-featured database with vector search. Best for production and multi-user systems.',
    },
  ];
}

/**
 * Sets up AI model configuration in the project's .env file based on user selection.
 *
 * @param {string} aiModel - The selected AI model ('local', 'openai', or 'claude')
 * @param {string} envFilePath - Path to the project's .env file
 * @param {boolean} isNonInteractive - Whether running in non-interactive mode
 * @returns {Promise<void>}
 */
async function setupAIModelConfig(
  aiModel: string,
  envFilePath: string,
  isNonInteractive = false
): Promise<void> {
  try {
    switch (aiModel) {
      case 'local': {
        console.info('[√] Using Local AI - no additional configuration needed');
        break;
      }

      case 'openai': {
        if (isNonInteractive) {
          // In non-interactive mode, just add placeholder
          let content = '';
          if (existsSync(envFilePath)) {
            content = await fs.readFile(envFilePath, 'utf8');
          }

          if (content && !content.endsWith('\n')) {
            content += '\n';
          }

          content += '\n# AI Model Configuration\n';
          content += '# OpenAI Configuration\n';
          content += 'OPENAI_API_KEY=your_openai_api_key_here\n';
          content += '# Get your API key from: https://platform.openai.com/api-keys\n';

          await fs.writeFile(envFilePath, content, 'utf8');
          console.info('[√] OpenAI placeholder configuration added to .env file');
        } else {
          // Interactive mode - prompt for OpenAI API key
          await promptAndStoreOpenAIKey(envFilePath);
        }
        break;
      }

      case 'claude': {
        if (isNonInteractive) {
          // In non-interactive mode, just add placeholder
          let content = '';
          if (existsSync(envFilePath)) {
            content = await fs.readFile(envFilePath, 'utf8');
          }

          if (content && !content.endsWith('\n')) {
            content += '\n';
          }

          content += '\n# AI Model Configuration\n';
          content += '# Anthropic API Configuration\n';
          content += 'ANTHROPIC_API_KEY=your_anthropic_api_key_here\n';
          content += '# Get your API key from: https://console.anthropic.com/\n';

          await fs.writeFile(envFilePath, content, 'utf8');
          console.info('[√] Anthropic API placeholder configuration added to .env file');
        } else {
          // Interactive mode - prompt for Anthropic API key
          await promptAndStoreAnthropicKey(envFilePath);
        }
        break;
      }

      default:
        console.warn(`Unknown AI model: ${aiModel}, skipping configuration`);
        return;
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Failed to set up AI model configuration: ${errorMessage}`);
  }
}

/**
 * Installs dependencies for the specified target directory, database, and selected plugins.
 * @param {string} targetDir - The directory where dependencies will be installed.
 * @param {string} database - The database for which the adapter will be installed.
 * @param {string[]} selectedPlugins - An array of selected plugins to be installed.
 * @returns {Promise<void>} A promise that resolves once all dependencies are installed.
 */
async function installDependencies(targetDir: string) {
  console.info('Installing dependencies...');

  // First just install basic dependencies
  try {
    await runBunCommand(['install', '--no-optional'], targetDir);
    console.log('Installed base dependencies');
  } catch (error) {
    console.warn(
      "Failed to install dependencies automatically. Please run 'bun install' manually."
    );
  }
}

/**
 * Initialize a new project, plugin, or agent.
 *
 * @param {Object} opts - Options for initialization.
 * @param {string} opts.dir - Installation directory.
 * @param {boolean} opts.yes - Skip confirmation.
 * @param {string} opts.type - Type to create (project, plugin, or agent).
 *
 * @returns {Promise<void>} Promise that resolves once the initialization process is complete.
 */
export const create = new Command()
  .name('create')
  .description('Initialize a new project, plugin, or agent')
  .option('-d, --dir <dir>', 'installation directory', '.')
  .option('-y, --yes', 'skip confirmation', false)
  .option('-t, --type <type>', 'type to create (project, plugin, or agent)', 'project')
  .option('--tee', 'create a TEE starter project', false)
  .argument('[name]', 'name for the project, plugin, or agent')
  .action(async (name, opts) => {
    // Set non-interactive mode if environment variable is set or if -y/--yes flag is present in process.argv
    if (
      process.env.ELIZA_NONINTERACTIVE === '1' ||
      process.env.ELIZA_NONINTERACTIVE === 'true' ||
      process.argv.includes('-y') ||
      process.argv.includes('--yes')
    ) {
      opts.yes = true;
    } else {
      opts.yes = false;
    }

    // Convert to a proper boolean (if not already)
    opts.yes = opts.yes === true || opts.yes === 'true';

    // Display banner and continue with initialization
    await displayBanner();

    try {
      // Parse options but use "" as the default for type to force prompting
      const initialOptions = {
        dir: opts.dir || '.',
        yes: opts.yes, // Already properly converted to boolean above
        type: opts.type || '',
        tee: opts.tee || false,
      };

      // Determine project type, respecting -y
      let projectType = initialOptions.type;
      if (!projectType) {
        if (initialOptions.yes) {
          // Default to project if -y is used and -t is omitted
          projectType = 'project';
        } else {
          // Prompt the user if -y is not used
          const { type } = await prompts({
            type: 'select',
            name: 'type',
            message: 'What would you like to create?',
            choices: [
              { title: 'Project - Contains agents and plugins', value: 'project' },
              {
                title: 'Plugin - Can be added to the registry and installed by others',
                value: 'plugin',
              },
              {
                title: 'Agent - Character definition file for an agent',
                value: 'agent',
              },
            ],
            initial: 0,
          });

          if (!type) {
            return;
          }
          projectType = type;
        }
      } else {
        // Validate the provided type if -t was used
        if (!['project', 'plugin', 'agent'].includes(projectType)) {
          console.error(`Invalid type: ${projectType}. Must be 'project', 'plugin', or 'agent'`);
          process.exit(1);
        }
      }

      // Now validate with zod after we've determined the type
      const options = initOptionsSchema.parse({
        ...initialOptions,
        type: projectType,
      });

      let postgresUrl: string | null = null;

      // Prompt for project/plugin name if not provided
      let projectName = name;
      if (!projectName) {
        if (options.yes) {
          projectName = options.type === 'plugin' ? 'myplugin' : 'myproject';
          console.info(`Using default name: ${projectName}`);
        } else {
          const { nameResponse } = await prompts({
            type: 'text',
            name: 'nameResponse',
            message: `What would you like to name your ${options.type}?`,
            validate: (value) => value.length > 0 || `${options.type} name is required`,
          });

          if (!nameResponse) {
            return;
          }
          projectName = nameResponse;
        }
      }

      // Validate project name according to npm package naming rules
      const validateProjectName = (name: string): boolean => {
        // Special case for creating a project in the current directory
        if (name === '.') {
          return true;
        }

        // Check for spaces
        if (name.includes(' ')) {
          return false;
        }

        // Basic npm package name validation (simplified version)
        // Only allow alphanumeric characters, hyphens, and underscores
        // Don't start with a dot or an underscore
        // Don't contain uppercase letters (for consistency)
        const validNameRegex = /^[a-z0-9][-a-z0-9._]*$/;
        return validNameRegex.test(name);
      };

      // Perform name validation
      if (!validateProjectName(projectName)) {
        console.error(colors.red(`Error: Invalid ${options.type} name "${projectName}".`));
        console.error(`${options.type} names must follow npm package naming conventions:`);
        console.error('- Cannot contain spaces');
        console.error('- Must contain only lowercase letters, numbers, hyphens, or underscores');
        console.error('- Cannot start with a dot or underscore');
        process.exit(1);
      }

      // For plugin initialization, ensure plugin- prefix and validate format
      if (options.type === 'plugin') {
        if (!projectName.startsWith('plugin-')) {
          const prefixedName = `plugin-${projectName}`;
          console.info(
            `Note: Using "${prefixedName}" as the directory name to match plugin naming convention`
          );
          projectName = prefixedName;
        }

        // Validate plugin name format: plugin-[alphanumeric]
        const pluginNameRegex = /^plugin-[a-z0-9]+(-[a-z0-9]+)*$/;
        if (!pluginNameRegex.test(projectName)) {
          console.error(colors.red(`Error: Invalid plugin name "${projectName}".`));
          console.error('Plugin names must follow the format: plugin-[alphanumeric]');
          console.error('Examples: plugin-test, plugin-my-service, plugin-ai-tools');
          process.exit(1);
        }
      }

      const targetDir = path.join(options.dir === '.' ? process.cwd() : options.dir, projectName);

      // Check if directory already exists and handle accordingly
      if (existsSync(targetDir)) {
        const files = await fs.readdir(targetDir);
        const isEmpty = files.length === 0 || files.every((f) => f.startsWith('.'));

        if (!isEmpty) {
          // Directory exists and is not empty - this should fail
          console.error(
            colors.red(`Error: Directory "${projectName}" already exists and is not empty.`)
          );
          console.error(
            'Please choose a different name or manually remove the directory contents first.'
          );
          handleError(new Error(`Directory "${projectName}" is not empty`));
          return;
        }
        // Directory exists but is empty - this is fine
        console.info(`Note: Directory "${projectName}" already exists but is empty. Continuing...`);
      }

      if (options.type === 'plugin') {
        // Create directory if it doesn't exist
        if (!existsSync(targetDir)) {
          await fs.mkdir(targetDir, { recursive: true });
        }

        const pluginName = projectName.startsWith('@elizaos/plugin-')
          ? projectName
          : `@elizaos/plugin-${projectName.replace('plugin-', '')}`;

        await copyTemplateUtil('plugin', targetDir, pluginName);

        console.info('Installing dependencies...');
        try {
          await runBunCommand(['install', '--no-optional'], targetDir);
          console.log('Dependencies installed successfully!');

          // Skip building in test environments to avoid tsup dependency issues
          if (
            process.env.ELIZA_NONINTERACTIVE === '1' ||
            process.env.ELIZA_NONINTERACTIVE === 'true'
          ) {
            console.log('Skipping build in non-interactive mode');
          } else {
            await buildProject(targetDir, true);
          }
        } catch (_error) {
          console.warn(
            "Failed to install dependencies automatically. Please run 'bun install' manually."
          );
        }

        console.log('Plugin initialized successfully!');
        const cdPath = options.dir === '.' ? projectName : path.relative(process.cwd(), targetDir);
        console.info(
          `\nYour plugin is ready! Here's your development workflow:\n\n[1] Development\n   cd ${cdPath}\n   ${colors.cyan('elizaos dev')}                   # Start development with hot-reloading\n\n[2] Testing\n   ${colors.cyan('elizaos test')}                  # Run automated tests\n   ${colors.cyan('elizaos start')}                 # Test in a live agent environment\n\n[3] Publishing\n   ${colors.cyan('elizaos publish --test')}        # Check registry requirements\n   ${colors.cyan('elizaos publish')}               # Submit to registry\n\n[?] Learn more: https://eliza.how/docs/cli/plugins`
        );
        process.stdout.write(`\u001B]1337;CurrentDir=${targetDir}\u0007`);

        // Add gitignore content
        const gitignorePath = join(targetDir, '.gitignore');
        const gitignoreContent = `
# Dependencies
node_modules/
bun.lockb

# Environment variables
.env
.env.local
.env.*.local

# IDE
.vscode/
.idea/

# Build outputs
dist/
build/
*.log

# OS files
.DS_Store
Thumbs.db

# Test coverage
coverage/

# ElizaOS specific
data/
.eliza/
.elizaos-migration.lock
`;
        await fs.writeFile(gitignorePath, gitignoreContent.trim());

        return;
      }

      if (options.type === 'agent') {
        // Agent character creation
        const characterName = projectName || 'MyAgent';

        // Start with the default Eliza character from the same source used by start.ts
        const agentTemplate = { ...elizaCharacter };

        // Update only the name property
        agentTemplate.name = characterName;

        // In messageExamples, replace "Eliza" with the new character name
        if (agentTemplate.messageExamples) {
          for (const conversation of agentTemplate.messageExamples) {
            for (const message of conversation) {
              if (message.name === 'Eliza') {
                message.name = characterName;
              }
            }
          }
        }

        // Set a simple filename - either the provided name or default
        const filename = characterName.endsWith('.json') ? characterName : `${characterName}.json`;

        // Make sure we're in the current directory
        const fullPath = path.join(process.cwd(), filename);

        // Write the character file
        await fs.writeFile(fullPath, JSON.stringify(agentTemplate, null, 2), 'utf8');

        console.log(`Agent character created successfully: ${filename}`);
        console.info(
          `\nYou can now use this agent with:\n  elizaos agent start --path ${filename}`
        );
        return;
      }

      // Create directory if it doesn't exist
      if (!existsSync(targetDir)) {
        await fs.mkdir(targetDir, { recursive: true });
      }

      const availableDatabases = getAvailableDatabases();
      let database: string;
      if (options.yes) {
        database = 'pglite';
        console.info(`Using default database: ${database}`);
      } else {
        const response = await prompts({
          type: 'select',
          name: 'database',
          message: 'Select your database:',
          choices: availableDatabases,
          initial: 0, // Default to Pglite
        });
        database = response.database;
      }

      if (!database) {
        console.error('No database selected or provided');
        handleError(new Error('No database selected or provided'));
        return;
      }

      // AI Model Selection
      const availableAIModels = getAvailableAIModels();
      let aiModel: string;
      if (options.yes) {
        aiModel = 'local';
        console.info(`Using default AI model: ${aiModel}`);
      } else {
        const response = await prompts({
          type: 'select',
          name: 'aiModel',
          message: 'Select your AI model:',
          choices: availableAIModels,
          initial: 0, // Default to local
        });
        aiModel = response.aiModel;
      }

      // Determine which template to use based on --tee flag
      const template = options.tee ? 'project-tee-starter' : 'project-starter';

      if (options.tee) {
        console.info('Creating TEE-enabled project with TEE capabilities...');
      }

      await copyTemplateUtil(template, targetDir, projectName);

      if (!aiModel) {
        console.error('No AI model selected or provided');
        handleError(new Error('No AI model selected or provided'));
        return;
      }

      // Define project-specific .env file path, this will be created if it doesn't exist by downstream functions.
      const projectEnvFilePath = path.join(targetDir, '.env');

      // Ensure proper directory creation in the new project
      const dirs = await ensureElizaDir(targetDir);
      logger.debug('Project directories set up:', dirs);

      if (database === 'pglite') {
        const projectPgliteDbDir = path.join(targetDir, '.elizadb');
        // Pass the target directory to ensure everything is created in the new project
        await setupPgLite(projectPgliteDbDir, projectEnvFilePath, targetDir);
        console.debug(`Pglite database will be stored in project directory: ${projectPgliteDbDir}`);
      } else if (database === 'postgres' && !postgresUrl) {
        // Store Postgres URL in the project's .env file.
        postgresUrl = await promptAndStorePostgresUrl(projectEnvFilePath);
      }

      // Setup AI model configuration
      await setupAIModelConfig(aiModel, projectEnvFilePath, options.yes);

      const srcDir = path.join(targetDir, 'src');
      if (!existsSync(srcDir)) {
        await fs.mkdir(srcDir);
      }

      await fs.mkdir(path.join(targetDir, 'knowledge'), { recursive: true });
      await installDependencies(targetDir);

      // Skip building in test environments to avoid tsup dependency issues
      if (process.env.ELIZA_NONINTERACTIVE === '1' || process.env.ELIZA_NONINTERACTIVE === 'true') {
        console.log('Skipping build in non-interactive mode');
      } else {
        await buildProject(targetDir);
      }

      console.log('Project initialized successfully!');
      const cdPath = options.dir === '.' ? projectName : path.relative(process.cwd(), targetDir);
      console.info(
        `\nYour project is ready! Here\'s what you can do next:\n1. \`cd ${cdPath}\` to change into your project directory\n2. Run \`elizaos start\` to start your project\n3. Visit \`http://localhost:3000\` (or your custom port) to view your project in the browser`
      );
      process.stdout.write(`\u001B]1337;CurrentDir=${targetDir}\u0007`);
    } catch (error) {
      handleError(error);
    }
  });
