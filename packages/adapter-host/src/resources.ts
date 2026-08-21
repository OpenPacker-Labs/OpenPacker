import type { RegistryDefinition, RegistryResourceType } from './types.js';
import { AdapterHostError } from './types.js';

/** Flatten `@type` to a list of type strings. */
export function resourceTypesOf(
  type: RegistryResourceType | readonly RegistryResourceType[],
): string[] {
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  return Array.isArray(type) ? [...type] : [type as string];
}

/** True when the definition advertises the resource type. */
export function hasResource(
  definition: RegistryDefinition,
  type: string,
): boolean {
  return definition.resources.some((resource) =>
    resourceTypesOf(resource['@type']).includes(type),
  );
}

/**
 * Require a resource type or fail closed.
 *
 * Missing type means unsupported — never invent an endpoint.
 */
export function requireResource(
  definition: RegistryDefinition,
  type: string,
): void {
  if (!hasResource(definition, type))
    throw new AdapterHostError(
      'UNSUPPORTED_OPERATION',
      `Registry ${definition.registryId} does not advertise ${type}`,
    );
}

/** First resource entry advertising `type`, if any. */
export function findResource(
  definition: RegistryDefinition,
  type: string,
): { '@id': string; types: string[] } | undefined {
  for (const resource of definition.resources) {
    const types = resourceTypesOf(resource['@type']);
    if (types.includes(type)) return { '@id': resource['@id'], types };
  }
  return undefined;
}
