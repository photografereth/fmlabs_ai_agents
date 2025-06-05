import {
  type Action,
  type ActionExample,
  ChannelType,
  composePrompt,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  Role,
  type State,
  type UUID,
  World,
} from '@elizaos/core';
import dedent from 'dedent';

/**
 * Determines if the user with the current role can modify the role to the new role.
 * @param currentRole The current role of the user making the change
 * @param targetRole The current role of the user being changed (null if new user)
 * @param newRole The new role to assign
 * @returns Whether the role change is allowed
 */
/**
 * Determines if a user with a given current role can modify the role of another user to a new role.
 * @param {Role} currentRole - The current role of the user attempting to modify the other user's role.
 * @param {Role | null} targetRole - The target user's current role. Can be null if the user does not exist.
 * @param {Role} newRole - The new role that the current user is attempting to set for the target user.
 * @returns {boolean} Returns true if the user can modify the role, false otherwise.
 */
const canModifyRole = (currentRole: Role, targetRole: Role | null, newRole: Role): boolean => {
  // User's can't change their own role
  if (targetRole === currentRole) return false;

  switch (currentRole) {
    // Owners can do everything
    case Role.OWNER:
      return true;
    // Admins can only create/modify users up to their level
    case Role.ADMIN:
      return newRole !== Role.OWNER;
    // Normal users can't modify roles
    case Role.NONE:
    default:
      return false;
  }
};

/**
 * Template for extracting role assignments from a conversation.
 *
 * @type {string} extractionTemplate - The template string containing information about the task, server members, available roles, recent messages, current speaker role, and extraction instructions.
 * @returns {string} JSON format of role assignments if valid role assignments are found, otherwise an empty array.
 */
const extractionTemplate = `# Task: Extract role assignments from the conversation

# Current Server Members:
{{serverMembers}}

# Available Roles:
- OWNER: Full control over the organization
- ADMIN: Administrative privileges
- NONE: Standard member access

# Recent Conversation:
{{recentMessages}}

# Current speaker role: {{speakerRole}}

# Instructions: Analyze the conversation and extract any role assignments being made by the speaker.
Only extract role assignments if:
1. The speaker has appropriate permissions to make the change
2. The role assignment is clearly stated
3. The target user is a valid server member
4. The new role is one of: OWNER, ADMIN, or NONE

Return the results in this JSON format:
{
"roleAssignments": [
  {
    "entityId": "<UUID of the entity being assigned to>",
    "newRole": "ROLE_NAME"
  }
]
}

If no valid role assignments are found, return an empty array.`;

/**
 * Interface representing a role assignment to a user.
 */
interface RoleAssignment {
  entityId: string;
  newRole: Role;
}

/**
 * Represents an action to update the role of a user within a server.
 * @typedef {Object} Action
 * @property {string} name - The name of the action.
 * @property {string[]} similes - The similar actions that can be performed.
 * @property {string} description - A description of the action and its purpose.
 * @property {Function} validate - A function to validate the action before execution.
 * @property {Function} handler - A function to handle the execution of the action.
 * @property {ActionExample[][]} examples - Examples demonstrating how the action can be used.
 */
export const updateRoleAction: Action = {
  name: 'UPDATE_ROLE',
  similes: ['CHANGE_ROLE', 'SET_PERMISSIONS', 'ASSIGN_ROLE', 'MAKE_ADMIN'],
  description: 'Assigns a role (Admin, Owner, None) to a user or list of users in a channel.',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    // Only activate in group chats where the feature is enabled
    const channelType = message.content.channelType as ChannelType;
    const serverId = message.content.serverId as string;

    return (
      // First, check if this is a supported channel type
      (channelType === ChannelType.GROUP || channelType === ChannelType.WORLD) &&
      // Then, check if we have a server ID
      !!serverId
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: any,
    callback?: HandlerCallback
  ): Promise<void> => {
    if (!state) {
      logger.error('State is required for role assignment');
      throw new Error('State is required for role assignment');
    }

    // Extract needed values from message and state
    const { roomId } = message;
    const serverId = message.content.serverId as string;
    const worldId = runtime.getSetting('WORLD_ID');

    // First, get the world for this server
    let world: World | null = null;

    if (worldId) {
      world = await runtime.getWorld(worldId as UUID);
    }

    if (!world) {
      logger.error('World not found');
      await callback?.({
        text: "I couldn't find the world. This action only works in a world.",
      });
      return;
    }

    if (!world.metadata?.roles) {
      world.metadata = world.metadata || {};
      world.metadata.roles = {};
    }

    // Get the entities for this room
    const entities = await runtime.getEntitiesForRoom(roomId);

    // Get the role of the requester
    const requesterRole = world.metadata.roles[message.entityId] || Role.NONE;

    // Construct extraction prompt
    const extractionPrompt = composePrompt({
      state: {
        ...state.values,
        content: state.text,
      },
      template: dedent`
				# Task: Parse Role Assignment

				I need to extract user role assignments from the input text. Users can be referenced by name, username, or mention.

				The available role types are:
				- OWNER: Full control over the server and all settings
				- ADMIN: Ability to manage channels and moderate content
				- NONE: Regular user with no special permissions

				# Current context:
				{{content}}

				Format your response as a JSON array of objects, each with:
				- entityId: The name or ID of the user
				- newRole: The role to assign (OWNER, ADMIN, or NONE)

				Example:
				\`\`\`json
				[
					{
						"entityId": "John",
						"newRole": "ADMIN"
					},
					{
						"entityId": "Sarah",
						"newRole": "OWNER"
					}
				]
				\`\`\`
			`,
    });

    // Extract role assignments using type-safe model call
    const result = await runtime.useModel<typeof ModelType.OBJECT_LARGE, RoleAssignment[]>(
      ModelType.OBJECT_LARGE,
      {
        prompt: extractionPrompt,
        schema: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              entityId: { type: 'string' },
              newRole: {
                type: 'string',
                enum: Object.values(Role),
              },
            },
            required: ['entityId', 'newRole'],
          },
        },
        output: 'array',
      }
    );

    if (!result?.length) {
      await callback?.({
        text: 'No valid role assignments found in the request.',
        actions: ['UPDATE_ROLE'],
        source: 'discord',
      });
      return;
    }

    // Process each role assignment
    let worldUpdated = false;

    for (const assignment of result) {
      let targetEntity = entities.find((e) => e.id === assignment.entityId);
      if (!targetEntity) {
        logger.error('Could not find an ID ot assign to');
      }

      const currentRole = world.metadata.roles[assignment.entityId];

      // Validate role modification permissions
      if (!canModifyRole(requesterRole, currentRole, assignment.newRole)) {
        await callback?.({
          text: `You don't have permission to change ${targetEntity?.names[0]}'s role to ${assignment.newRole}.`,
          actions: ['UPDATE_ROLE'],
          source: 'discord',
        });
        continue;
      }

      // Update role in world metadata
      world.metadata.roles[assignment.entityId] = assignment.newRole;

      worldUpdated = true;

      await callback?.({
        text: `Updated ${targetEntity?.names[0]}'s role to ${assignment.newRole}.`,
        actions: ['UPDATE_ROLE'],
        source: 'discord',
      });
    }

    // Save updated world metadata if any changes were made
    if (worldUpdated) {
      await runtime.updateWorld(world);
      logger.info(`Updated roles in world metadata for server ${serverId}`);
    }
  },

  examples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Make {{name2}} an ADMIN',
          source: 'discord',
        },
      },
      {
        name: '{{name3}}',
        content: {
          text: "Updated {{name2}}'s role to ADMIN.",
          actions: ['UPDATE_ROLE'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Set @alice and @bob as admins',
          source: 'discord',
        },
      },
      {
        name: '{{name3}}',
        content: {
          text: "Updated alice's role to ADMIN.\nUpdated bob's role to ADMIN.",
          actions: ['UPDATE_ROLE'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Ban @troublemaker',
          source: 'discord',
        },
      },
      {
        name: '{{name3}}',
        content: {
          text: 'I cannot ban users.',
          actions: ['REPLY'],
        },
      },
    ],
  ] as ActionExample[][],
};
