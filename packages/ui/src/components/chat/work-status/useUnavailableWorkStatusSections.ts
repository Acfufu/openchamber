import { useUIStore } from '@/stores/useUIStore';
import type { WorkStatusSectionId } from './sections';

const NONE_UNAVAILABLE: readonly WorkStatusSectionId[] = [];
const WORKFLOWS_UNAVAILABLE: readonly WorkStatusSectionId[] = ['workflows'];

/**
 * Built-in sections of features this build may not have. A section of a
 * feature the build lacks is listed nowhere, the sections dialog included, so
 * an unreleased feature does not show up by name.
 */
export const useUnavailableWorkStatusSections = (): readonly WorkStatusSectionId[] => {
  const workflows = useUIStore((state) => state.agentWorkflowFeatureAvailable);
  return workflows ? NONE_UNAVAILABLE : WORKFLOWS_UNAVAILABLE;
};
