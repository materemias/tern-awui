// Web Push settings derived from the server's environment.

/**
 * The VAPID subject: the contact the browser's push service (FCM for Chrome) sees for this key.
 * `$TERN_AWUI_VAPID_SUBJECT`, else `mailto:` the first allowed login when it is an address,
 * else a placeholder that names nobody.
 */
export function vapidSubject(env: Record<string, string | undefined>, allow: string[]): string {
  if (env.TERN_AWUI_VAPID_SUBJECT) return env.TERN_AWUI_VAPID_SUBJECT;
  return allow[0]?.includes("@") ? `mailto:${allow[0]}` : "https://tern-mobile.invalid";
}
