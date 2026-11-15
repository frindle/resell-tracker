import { handleEmail, handleFetch } from './handlers.js';

export default {
  async email(message, env, ctx) {
    await handleEmail(message, env);
  },
  async fetch(request, env) {
    return handleFetch(request, env);
  },
};
