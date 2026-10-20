/**
 * A subagent name as omp writes it (and the server accepts): no separators, no leading dot or underscore,
 * so it can't escape the session's subagent folder. Shared with the web app; keep this file import-free.
 */
export const SUBAGENT_NAME = /^[A-Za-z0-9][\w.-]{0,127}$/;
