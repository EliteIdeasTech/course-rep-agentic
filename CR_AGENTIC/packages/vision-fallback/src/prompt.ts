import { CHALLENGE_ANSWER_PLACEHOLDER, PASSWORD_PLACEHOLDER, type VisionGoal } from './types';

export function buildGoalPrompt(goal: VisionGoal, portalUrl: string, username?: string): string {
  const shared = [
    'You are looking at one student portal in a browser. Stay school-agnostic: do not assume a vendor or a campus.',
    `Stay on the registrable domain of ${portalUrl}. Do not open any other site.`,
    'Do not guess, invent, or type a URL. Only open a link that is visible on the current page.',
    'Do not click Pay, payment, checkout, Register courses, course registration, Delete, or any Submit button that is not the login button.',
    'If you see a captcha, one-time code, 2FA prompt, or security question, do not solve it, do not guess, and do not use a captcha service.',
    'Reply with one line: USER_INPUT {"kind":"otp"|"captcha"|"security_question","prompt":"short instruction for the student"}.',
    'Do not ask the student to navigate, pick a menu, or find a page. Only pause for an OTP, captcha, or security question.',
    'After the student answers, the browser types it. You will not see the answer.',
  ];
  const challengeType = `If you must type into that field, type exactly ${CHALLENGE_ANSWER_PLACEHOLDER} and nothing else.`;
  if (goal === 'find_login_form') {
    return [
      ...shared,
      'Find the login form. Do not type anything and do not submit.',
      'When a username field and a password field are both visible, reply LOGIN_FORM_FOUND.',
    ].join('\n');
  }
  if (goal === 'extract') {
    return [
      ...shared,
      'The student is already signed in. Do not type a password and do not submit any form.',
      challengeType,
      'Open the pages that show the profile (name, matric or registration number, department, level), the registered courses (code, title, units), and results or GPA if they exist.',
      'When those pages have been opened, or they are not in the portal, reply DONE.',
    ].join('\n');
  }
  return [
    ...shared,
    username
      ? `Type this username exactly into the username field: ${username}`
      : 'Type the username that is already on screen if a field is empty.',
    `Type this placeholder exactly into the password field and nothing else: ${PASSWORD_PLACEHOLDER}`,
    challengeType,
    'Do not invent, repeat, or guess a password. You do not know the password.',
    'You may submit only the login form.',
    'After sign-in, open the profile (name, matric or registration number, department, level), the registered courses (code, title, units), and results or GPA if they exist. Do not change any data.',
    'When those pages have been opened, or sign-in cannot continue, reply DONE.',
  ].join('\n');
}
