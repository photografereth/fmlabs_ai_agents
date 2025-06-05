import CharacterForm from '@/components/character-form';
import StopAgentButton from '@/components/stop-agent-button';
import { useAgentUpdate } from '@/hooks/use-agent-update';
import { useToast } from '@/hooks/use-toast';
import { apiClient } from '@/lib/api';
import type { Agent, UUID } from '@elizaos/core';
import { AgentStatus } from '@elizaos/core';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import AvatarPanel from './avatar-panel';
import PluginsPanel from './plugins-panel';
import { SecretPanel } from './secret-panel';

export default function AgentSettings({ agent, agentId }: { agent: Agent; agentId: UUID }) {
  const { toast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [isDeleting, setIsDeleting] = useState(false);
  const isActive = agent?.status === AgentStatus.ACTIVE;

  // Use our enhanced agent update hook for more intelligent handling of JSONb fields
  const agentState = useAgentUpdate(agent);

  const handleSubmit = async () => {
    try {
      if (!agentId) {
        throw new Error('Agent ID is missing');
      }

      // Get only the fields that have changed
      const changedFields = agentState.getChangedFields();

      // No need to send update if nothing changed
      if (Object.keys(changedFields).length === 0) {
        toast({
          title: 'No Changes',
          description: 'No changes were made to the agent',
        });
        navigate('/');
        return;
      }

      // Always include the ID
      const partialUpdate = {
        id: agentId,
        ...changedFields,
      };

      // Send the partial update
      await apiClient.updateAgent(agentId, partialUpdate as Agent);

      // Invalidate both the agent query and the agents list
      queryClient.invalidateQueries({ queryKey: ['agent', agentId] });
      queryClient.invalidateQueries({ queryKey: ['agents'] });

      navigate('/');

      toast({
        title: 'Success',
        description: 'Agent updated and restarted successfully',
      });
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to update agent',
        variant: 'destructive',
      });
      throw error;
    }
  };

  const handleDelete = async () => {
    if (isDeleting) return; // Prevent multiple clicks

    try {
      // Add confirmation dialog
      const confirmDelete = window.confirm(
        `Are you sure you want to delete the agent "${agent.name}"? This action cannot be undone.`
      );

      if (!confirmDelete) {
        return;
      }

      // Set deleting state
      setIsDeleting(true);

      // Show a toast to indicate deletion is in progress
      toast({
        title: 'Deleting...',
        description: `Deleting agent "${agent.name}"`,
      });

      let responseReceived = false;
      let navigationTimer = null;

      try {
        // Set a timeout to navigate away if the deletion takes too long
        navigationTimer = setTimeout(() => {
          if (!responseReceived) {
            queryClient.invalidateQueries({ queryKey: ['agents'] });
            navigate('/');
            toast({
              title: 'Note',
              description: 'Deletion is still processing in the background.',
            });
          }
        }, 8000);

        const response = await apiClient.deleteAgent(agentId);
        responseReceived = true;

        if (navigationTimer) {
          clearTimeout(navigationTimer);
          navigationTimer = null;
        }

        // Handle partial success response
        if (response && 'partial' in response && response.partial === true) {
          toast({
            title: 'Processing',
            description: 'Deletion is still in progress and will complete in the background.',
          });
        } else {
          toast({
            title: 'Success',
            description: 'Agent deleted successfully',
          });
        }

        // Invalidate queries and navigate away regardless
        queryClient.invalidateQueries({ queryKey: ['agents'] });
        navigate('/');
      } catch (deleteError) {
        responseReceived = true;

        if (navigationTimer) {
          clearTimeout(navigationTimer);
          navigationTimer = null;
        }

        // Handle specific error codes
        if (deleteError instanceof Error) {
          const errorMessage = deleteError.message;
          const statusCode = (deleteError as any).statusCode;

          if (
            statusCode === 409 ||
            errorMessage.includes('409') ||
            errorMessage.includes('Conflict') ||
            errorMessage.includes('foreign key constraint') ||
            errorMessage.includes('active references')
          ) {
            // Conflict - agent has references that prevent deletion
            toast({
              title: 'Cannot Delete',
              description:
                'This agent cannot be deleted because it has active references. Try stopping the agent first.',
              variant: 'destructive',
            });
          } else if (
            statusCode === 408 ||
            statusCode === 504 ||
            errorMessage.includes('408') ||
            errorMessage.includes('504') ||
            errorMessage.includes('timeout') ||
            errorMessage.includes('timed out')
          ) {
            // Timeout - operation is still running in background
            toast({
              title: 'Operation Timeout',
              description:
                'The deletion is taking longer than expected and will continue in the background.',
              variant: 'destructive',
            });

            // Still navigate away
            queryClient.invalidateQueries({ queryKey: ['agents'] });
            navigate('/');
          } else {
            // Generic error
            toast({
              title: 'Error',
              description: errorMessage || 'Failed to delete agent',
              variant: 'destructive',
            });
          }
        } else {
          // Unknown error
          toast({
            title: 'Error',
            description: 'An unknown error occurred while deleting the agent',
            variant: 'destructive',
          });
        }
      }
    } catch (error) {
      // Outer try/catch fallback
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to delete agent',
        variant: 'destructive',
      });
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <CharacterForm
      characterValue={agentState.agent}
      setCharacterValue={agentState}
      title="Agent Settings"
      description="Configure your AI agent's behavior and capabilities"
      onSubmit={handleSubmit}
      onReset={agentState.reset}
      onDelete={handleDelete}
      stopAgentButton={
        isActive ? <StopAgentButton agent={agent} redirectToHome={true} /> : undefined
      }
      isAgent={true}
      isDeleting={isDeleting}
      customComponents={[
        {
          name: 'Plugins',
          component: (
            <PluginsPanel
              characterValue={agentState.agent}
              setCharacterValue={agentState}
              initialPlugins={agent.plugins}
            />
          ),
        },
        {
          name: 'Secret',
          component: (
            <SecretPanel
              characterValue={agentState.agent}
              onChange={(updatedAgent) => {
                if (updatedAgent.settings?.secrets) {
                  // Create a new settings object with the updated secrets
                  const updatedSettings = {
                    ...agentState.agent.settings,
                    secrets: updatedAgent.settings.secrets,
                  };

                  // Use updateSettings to properly handle the secrets
                  agentState.updateSettings(updatedSettings);
                }
              }}
            />
          ),
        },
        {
          name: 'Avatar',
          component: (
            <AvatarPanel characterValue={agentState.agent} setCharacterValue={agentState} />
          ),
        },
      ]}
    />
  );
}
