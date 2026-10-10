import { PASSWORD_PLACEHOLDER } from './types';

export function substitutePassword(text: string, password: string): {
  text: string;
  substituted: boolean;
} {
  if (!text.includes(PASSWORD_PLACEHOLDER)) {
    return { text, substituted: false };
  }
  return {
    text: text.split(PASSWORD_PLACEHOLDER).join(password),
    substituted: true,
  };
}

/** Removes the live password and the placeholder from anything that might be logged or sent back. */
export function redactSecrets(value: string, secrets: Array<string | undefined | null>): string {
  let out = value;
  const needles = [PASSWORD_PLACEHOLDER, ...secrets.filter((s): s is string => !!s && s.length > 0)];
  for (const secret of needles) {
    if (!out.includes(secret)) continue;
    out = out.split(secret).join('[redacted]');
  }
  return out;
}

export function assertNoPassword(payload: string, password: string): boolean {
  if (!password) return true;
  return !payload.includes(password);
}
