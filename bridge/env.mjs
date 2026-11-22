// ZELLIJ_DECK_* is the public prefix; the pre-rename WEBSHELL_* names remain accepted.
export function setting(env, name) {
  return env[`ZELLIJ_DECK_${name}`] || env[`WEBSHELL_${name}`] || undefined;
}
