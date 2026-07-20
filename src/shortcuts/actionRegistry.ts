export type ActionTrigger = 'shortcut' | 'toolbar' | 'menu' | 'system';

export interface ActionContext {
  shift: boolean;
  alt: boolean;
  mod: boolean;
}

export type ActionHandler = (
  context: ActionContext,
  trigger: ActionTrigger,
) => void;

const EMPTY_CONTEXT: ActionContext = { shift: false, alt: false, mod: false };
const boundActions = new Map<string, Set<ActionHandler>>();

export function bindAction(id: string, handler: ActionHandler): () => void {
  const handlers = boundActions.get(id) ?? new Set<ActionHandler>();
  handlers.add(handler);
  boundActions.set(id, handlers);
  return () => {
    handlers.delete(handler);
    if (!handlers.size) boundActions.delete(id);
  };
}

export function invokeAction(
  id: string,
  context: ActionContext = EMPTY_CONTEXT,
  trigger: ActionTrigger = 'system',
): boolean {
  const handlers = boundActions.get(id);
  if (!handlers?.size) return false;
  for (const handler of handlers) handler(context, trigger);
  return true;
}

export function clearActionRegistry(): void {
  boundActions.clear();
}
