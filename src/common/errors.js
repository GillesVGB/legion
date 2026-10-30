export class UserError extends Error {}

export function assertUser(condition, message) {
  if (!condition) throw new UserError(message);
}
