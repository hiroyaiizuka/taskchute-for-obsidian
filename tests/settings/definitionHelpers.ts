import type {
  SettingDefinition,
  SettingDefinitionControl,
  SettingDefinitionItem,
  SettingDefinitionPage,
} from 'obsidian';

/**
 * Helpers for asserting against the tree returned by getSettingDefinitions().
 *
 * The declarative API makes a settings tab plain data, so tests can look items
 * up by key or name instead of spying on render order.
 */

type Container = { items?: SettingDefinitionItem[] };

function childrenOf(item: SettingDefinitionItem): SettingDefinitionItem[] {
  return (item as Container).items ?? [];
}

/** Every definition in the tree, groups and pages walked depth-first. */
export function flatten(
  items: readonly SettingDefinitionItem[],
): SettingDefinitionItem[] {
  return items.flatMap((item) => [item, ...flatten(childrenOf(item))]);
}

function isControl(
  item: SettingDefinitionItem,
): item is SettingDefinitionControl {
  return 'control' in item && item.control !== undefined;
}

/** The control definition bound to `key`, anywhere in the tree. */
export function findByKey(
  items: readonly SettingDefinitionItem[],
  key: string,
): SettingDefinitionControl | undefined {
  return flatten(items)
    .filter(isControl)
    .find((item) => item.control.key === key);
}

/** The first definition whose display name is exactly `name`. */
export function findByName(
  items: readonly SettingDefinitionItem[],
  name: string,
): SettingDefinition | undefined {
  return flatten(items).find(
    (item): item is SettingDefinition =>
      'name' in item && item.name === name && !('type' in item),
  );
}

/** The page whose entry is named `name`. */
export function pageNamed(
  items: readonly SettingDefinitionItem[],
  name: string,
): SettingDefinitionPage | undefined {
  return flatten(items).find(
    (item): item is SettingDefinitionPage =>
      'type' in item && item.type === 'page' && item.name === name,
  );
}

/** Group and page headings in tree order — handy for asserting section order. */
export function headings(items: readonly SettingDefinitionItem[]): string[] {
  return flatten(items).flatMap((item) => {
    if (!('type' in item)) return [];
    if (item.type === 'page') return [item.name];
    return item.heading ? [item.heading] : [];
  });
}

/** Resolves a `visible` predicate to a boolean, defaulting to visible. */
export function isVisible(item: {
  visible?: boolean | (() => boolean);
}): boolean {
  if (item.visible === undefined) return true;
  return typeof item.visible === 'function' ? item.visible() : item.visible;
}
