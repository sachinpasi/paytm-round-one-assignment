// set by server.js, read by /readyz and the readiness middleware
export const state = {
  ready: false, // database reachable and migrated
  stopping: false,
};
