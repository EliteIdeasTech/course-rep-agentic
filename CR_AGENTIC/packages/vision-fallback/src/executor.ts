import type { ComputerSurface, ModelFunctionCall } from './types';
import { decideAction, type ActionPlan, type DecideContext } from './decide';
import { registrableDomain } from './domain';

export interface ExecutedAction {
  plan: ActionPlan;
  error?: string;
}

export async function executeAction(
  call: ModelFunctionCall,
  surface: ComputerSurface,
  ctx: Omit<DecideContext, 'element' | 'viewport' | 'currentUrl'>,
): Promise<ExecutedAction> {
  const viewport = surface.viewport();
  const currentUrl = surface.url();
  const point = typeof call.arguments?.x === 'number' && typeof call.arguments?.y === 'number'
    ? {
        x: Math.floor((Math.min(999, Math.max(0, call.arguments.x)) / 1000) * viewport.width),
        y: Math.floor((Math.min(999, Math.max(0, call.arguments.y)) / 1000) * viewport.height),
      }
    : null;
  const element = point ? await surface.elementAt(point.x, point.y) : null;
  const plan = decideAction(call, { ...ctx, element, viewport, currentUrl });
  if (plan.kind !== 'execute') return { plan };

  try {
    const action = plan.action;
    if (action.kind === 'click') {
      await surface.click(action.x, action.y, action.button, action.clickCount);
    } else if (action.kind === 'move') {
      await surface.move(action.x, action.y);
    } else if (action.kind === 'type') {
      await surface.typeText(action.text, action.pressEnter);
    } else if (action.kind === 'scroll') {
      await surface.scroll(action.x, action.y, action.direction, action.pixels);
    } else if (action.kind === 'navigate') {
      await surface.navigate(action.url);
      const after = isStillOnPortal(surface.url(), ctx.portalUrl);
      if (!after) {
        await surface.goBack().catch(() => undefined);
        return { plan, error: 'left the portal domain after navigation' };
      }
    } else if (action.kind === 'go_back') {
      await surface.goBack();
    } else if (action.kind === 'go_forward') {
      await surface.goForward();
    } else if (action.kind === 'wait') {
      await surface.wait(action.ms);
    } else if (action.kind === 'press_key') {
      await surface.pressKey(action.key);
    }
    return { plan };
  } catch (err) {
    return { plan, error: err instanceof Error ? err.message : String(err) };
  }
}

function isStillOnPortal(current: string, portalUrl: string): boolean {
  try {
    return registrableDomain(new URL(current).hostname) === registrableDomain(new URL(portalUrl).hostname);
  } catch {
    return false;
  }
}
