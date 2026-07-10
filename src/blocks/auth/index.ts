// Block: Authentication
// GitHub OAuth, token management, user creation
// Depends on: security, shared/db

export { registerAuthRoutes } from './routes.js';
export { authenticate } from './middleware.js';
