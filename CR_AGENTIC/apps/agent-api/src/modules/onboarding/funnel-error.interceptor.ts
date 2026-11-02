import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, catchError, from, mergeMap, throwError } from 'rxjs';
import { recordFunnelEvent } from '@cr-agentic/database';
import { classifyFunnelError } from '@cr-agentic/shared';

/** Route suffix -> funnel step the request was trying to reach. */
export function funnelStepForRoute(path: string): string | null {
  const p = path.replace(/\?.*$/, '');
  if (/\/discover-portal$/.test(p)) return 'portal_discovering';
  if (/\/portal-candidates$/.test(p)) return 'portal_suggested';
  if (/\/confirm-portal(-manual)?$/.test(p)) return 'portal_accepted';
  if (/\/login\/start$/.test(p)) return 'awaiting_login';
  if (/\/login\/credentials$/.test(p)) return 'credentials_submitted';
  if (/\/login\/(status|complete)$|\/login-bridge$/.test(p)) return 'session_captured';
  if (/\/claim-identity$/.test(p)) return 'session_captured';
  if (/\/(discover-academics|discovery-results|apply-results|sync-to-course-rep)$/.test(p)) return 'importing';
  return null;
}

/**
 * Records a `failed` funnel event for any onboarding request that throws, with
 * the real exception class, HTTP status and a sanitised message, then rethrows
 * unchanged. Request bodies are never read here (they can hold credentials).
 */
@Injectable()
export class FunnelErrorInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<{
      params?: Record<string, string>;
      originalUrl?: string;
      url?: string;
      method?: string;
    }>();
    const sessionId = req?.params?.sessionId;
    const path = req?.originalUrl ?? req?.url ?? '';
    return next.handle().pipe(
      catchError((err: unknown) => {
        if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId) || (req.method === 'GET' && !/login\/status/.test(path))) {
          return throwError(() => err);
        }
        const c = classifyFunnelError(err);
        // 404 = not this caller's session: nothing to attribute.
        if (c.httpStatus === 404) return throwError(() => err);
        const step = funnelStepForRoute(path);
        return from(
          recordFunnelEvent({
            sessionId,
            event: 'failed',
            step,
            reason: step === 'credentials_submitted' && c.reason === 'unknown' ? 'start_failed' : c.reason,
            rawReason: 'request_error',
            errorClass: c.errorClass,
            httpStatus: c.httpStatus ?? null,
            message: c.message,
            source: 'server',
            metadata: { route: path.replace(/^.*\/onboarding\/[^/]+/, '').slice(0, 60) || '/' },
          }),
        ).pipe(mergeMap(() => throwError(() => err)));
      }),
    );
  }
}
